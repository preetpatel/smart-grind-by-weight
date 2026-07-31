// Multi-Session Analysis: port of the Streamlit report's comparative view —
// overview statistics, predictive-phase tuning, and pulse effectiveness
// across a filtered set of sessions.

import { MODE_MAP, PROFILE_MAP } from './parser.js';
import { pearson, mean, stddev } from './frame.js';
import { COLOR_WEIGHT, grindTimeSeconds, chartLayout, CHART_CONFIG } from './charts.js';

const TOLERANCE_G = 0.03;
const COLOR_TOLERANCE = '#e66767';
const COLOR_PERFECT = '#0ca30c';
const COLOR_REFERENCE = '#898781';
const COLOR_METHOD_ALT = '#d95926'; // 1500ms-average method, distinct from the 95p method

// Status colors: fixed identities from the reserved status palette, not cycled
// (COMPLETE=good, OVERSHOOT=warning, MAX_PULSES=serious, TIMEOUT=critical).
const STATUS_COLORS = {
    COMPLETE: '#0ca30c',
    OVERSHOOT: '#fab219',
    TIMEOUT: '#d03b3b',
    MAX_PULSES: '#ec835a',
};

function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else node.setAttribute(key, value);
    }
    for (const child of children) node.appendChild(child);
    return node;
}

function metricTile(label, value) {
    return el('div', { class: 'metric' }, [
        el('div', { class: 'metric-label', text: label }),
        el('div', { class: 'metric-value', text: value }),
    ]);
}

function infoBox(text, type = 'info') {
    return el('div', { class: `status ${type}`, text });
}

function chartDiv(container, cls = 'chart-container small') {
    const div = el('div', { class: cls });
    container.appendChild(div);
    return div;
}

const baseLayout = chartLayout;
const CONFIG = CHART_CONFIG;

function vline(x, color, dash = 'dash') {
    return { type: 'line', xref: 'x', yref: 'paper', x0: x, x1: x, y0: 0, y1: 1, line: { color, width: 1.5, dash } };
}

function hline(y, color, dash = 'dash') {
    return { type: 'line', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: y, y1: y, line: { color, width: 1.5, dash } };
}

// error_grams recomputed as final - target, as the report does for old data.
function errorOf(session) {
    return session.final_weight - session.target_weight;
}

export function applyMultiFilters(records, filters) {
    return records.filter((r) => {
        const s = r.session;
        if (filters.mode !== 'All' && (MODE_MAP[s.grind_mode] ?? 'WEIGHT') !== filters.mode.toUpperCase()) return false;
        if (filters.profile !== 'All' && (PROFILE_MAP[s.profile_id] ?? String(s.profile_id)) !== filters.profile) return false;
        if (s.session_id < filters.idMin || s.session_id > filters.idMax) return false;
        return true;
    });
}

// Per-session derived data used by the predictive and pulse tabs.
function predictiveAnalysis(records) {
    const rows = [];
    for (const record of records) {
        const predictive = record.events.find((e) => e.phase_name === 'PREDICTIVE');
        if (!predictive) continue;
        const predEnd = predictive.timestamp_ms + predictive.duration_ms;
        const settle = record.events
            .filter((e) => ['PULSE_SETTLING', 'FINAL_SETTLING', 'PRIME_SETTLING'].includes(e.phase_name)
                && e.timestamp_ms >= predEnd)
            .sort((a, b) => a.timestamp_ms - b.timestamp_ms)[0] || null;

        const totalYield = settle
            ? settle.end_weight - predictive.start_weight
            : predictive.end_weight - predictive.start_weight;
        rows.push({
            sessionId: record.session_id,
            motorStopTarget: predictive.motor_stop_target_weight,
            grindLatencyMs: predictive.grind_latency_ms,
            pulseFlowRate: predictive.pulse_flow_rate,
            coastingYield: settle ? settle.end_weight - predictive.end_weight : 0,
            predictiveError: totalYield - record.session.target_weight,
            finalError: errorOf(record.session),
        });
    }
    return rows;
}

// merge_asof(direction='forward', tolerance=5000) equivalent: each pulse pairs
// with the first settling event that follows it within 5s in the same session.
function pulseAnalysis(records) {
    const rows = [];
    for (const record of records) {
        const predictive = record.events.find((e) => e.phase_name === 'PREDICTIVE');
        const pulseFlowRate = predictive ? predictive.pulse_flow_rate : 0;

        // Average flow over the last 1500ms of the predictive phase
        let avgFlow1500 = 0;
        if (predictive) {
            const predEnd = predictive.timestamp_ms + predictive.duration_ms;
            const windowMeasurements = record.measurements.filter((m) => m.phase_name === 'PREDICTIVE'
                && m.timestamp_ms >= predEnd - 1500 && m.timestamp_ms <= predEnd);
            avgFlow1500 = mean(windowMeasurements.map((m) => m.flow_rate_g_per_s));
        }

        const settles = record.events.filter((e) => e.phase_name === 'PULSE_SETTLING')
            .sort((a, b) => a.timestamp_ms - b.timestamp_ms);
        for (const pulse of record.events.filter((e) => e.phase_name === 'PULSE_EXECUTE')) {
            const settle = settles.find((s) => s.timestamp_ms >= pulse.timestamp_ms
                && s.timestamp_ms - pulse.timestamp_ms <= 5000) || null;
            const finalWeight = settle ? settle.end_weight : pulse.end_weight;
            rows.push({
                sessionId: record.session_id,
                durationMs: pulse.pulse_duration_ms,
                pulseYield: Math.max(0, finalWeight - pulse.start_weight),
                expectedYield: (pulse.pulse_duration_ms / 1000) * pulseFlowRate,
                expectedYield1500: (pulse.pulse_duration_ms / 1000) * avgFlow1500,
            });
        }
    }
    return rows;
}

function scatterWithIdentityLine(rows, xKey, yKey, title, xTitle, yTitle, color) {
    const xs = rows.map((r) => r[xKey]);
    const ys = rows.map((r) => r[yKey]);
    const lo = Math.min(...xs, ...ys);
    const hi = Math.max(...xs, ...ys);
    return {
        traces: [
            {
                x: xs, y: ys, mode: 'markers', marker: { size: 8, opacity: 0.6, color },
                customdata: rows.map((r) => r.sessionId),
                hovertemplate: `Session %{customdata}<br>${xTitle}: %{x:.3f}<br>${yTitle}: %{y:.3f}<extra></extra>`,
            },
            { x: [lo, hi], y: [lo, hi], mode: 'lines', line: { dash: 'dash', color: COLOR_REFERENCE }, hoverinfo: 'skip' },
        ],
        layout: baseLayout(title, xTitle, yTitle),
        config: CONFIG,
    };
}

function renderOverviewTab(container, records, plot) {
    const errors = records.map((r) => errorOf(r.session));
    const withinTolerance = errors.filter((e) => Math.abs(e) < TOLERANCE_G).length;
    const grindTimes = records.map((r) => grindTimeSeconds(r.events)).filter((t) => t > 0);

    container.appendChild(el('div', { class: 'metric-grid' }, [
        metricTile('Accuracy Rate', `${((withinTolerance / records.length) * 100).toFixed(1)}%`),
        metricTile('Average Error', `${mean(errors) >= 0 ? '+' : ''}${mean(errors).toFixed(3)}g`),
        metricTile('Error Std Dev', Number.isNaN(stddev(errors)) ? 'n/a' : `${stddev(errors).toFixed(3)}g`),
        metricTile('Avg Grind Time', `${mean(grindTimes).toFixed(1)}s`),
    ]));

    const row = el('div', { class: 'chart-row' });
    container.appendChild(row);

    // Error distribution histogram with tolerance guides
    const histogram = {
        traces: [{
            type: 'histogram', x: errors, nbinsx: 20, marker: { color: COLOR_WEIGHT },
            hovertemplate: '%{x}: %{y} sessions<extra></extra>',
        }],
        layout: {
            ...baseLayout('Weight Error Distribution', 'Error (g)', 'Count'),
            shapes: [vline(TOLERANCE_G, COLOR_TOLERANCE), vline(-TOLERANCE_G, COLOR_TOLERANCE), vline(0, COLOR_PERFECT, 'solid')],
        },
        config: CONFIG,
    };
    plot(chartDiv(row), histogram);

    // Result status breakdown
    const counts = new Map();
    for (const r of records) counts.set(r.session.result_status, (counts.get(r.session.result_status) || 0) + 1);
    const labels = [...counts.keys()];
    plot(chartDiv(row), {
        traces: [{
            type: 'pie', labels, values: labels.map((l) => counts.get(l)),
            marker: { colors: labels.map((l) => STATUS_COLORS[l] || COLOR_REFERENCE) },
            hovertemplate: '%{label}: %{value} sessions (%{percent})<extra></extra>',
        }],
        layout: { ...baseLayout('Grind Outcomes', '', ''), showlegend: true, legend: { orientation: 'h' } },
        config: CONFIG,
    });

    // Trend over session id
    plot(chartDiv(container, 'chart-container small'), {
        traces: [{
            x: records.map((r) => r.session_id), y: errors,
            mode: 'markers', marker: { size: 7, opacity: 0.7, color: COLOR_WEIGHT },
            hovertemplate: 'Session %{x}<br>Error: %{y:.3f}g<extra></extra>',
        }],
        layout: {
            ...baseLayout('Error vs Session ID (Time Progression)', 'Session ID', 'Error (g)'),
            shapes: [hline(TOLERANCE_G, COLOR_TOLERANCE), hline(-TOLERANCE_G, COLOR_TOLERANCE), hline(0, COLOR_PERFECT, 'solid')],
        },
        config: CONFIG,
    });
}

function renderPredictiveMultiTab(container, records, plot) {
    const rows = predictiveAnalysis(records);
    if (!rows.length) {
        container.appendChild(infoBox('No predictive phase data available for the selected sessions.'));
        return;
    }

    container.appendChild(el('div', { class: 'metric-grid' }, [
        metricTile('Avg Undershoot Target', `${mean(rows.map((r) => r.motorStopTarget)).toFixed(3)}g`),
        metricTile('Avg Predictive Error', `${mean(rows.map((r) => r.predictiveError)) >= 0 ? '+' : ''}${mean(rows.map((r) => r.predictiveError)).toFixed(3)}g`),
        metricTile('Avg Coasting Yield', `${mean(rows.map((r) => r.coastingYield)).toFixed(3)}g`),
        metricTile('Avg Grind Latency', `${mean(rows.map((r) => r.grindLatencyMs)).toFixed(0)}ms`),
        metricTile('Avg Flow Rate', `${mean(rows.map((r) => r.pulseFlowRate)).toFixed(3)}g/s`),
    ]));

    const row = el('div', { class: 'chart-row' });
    container.appendChild(row);

    plot(chartDiv(row), {
        traces: [{ type: 'histogram', x: rows.map((r) => r.motorStopTarget), nbinsx: 20, marker: { color: COLOR_WEIGHT } }],
        layout: baseLayout('Motor Stop Target Weight Distribution', 'Undershoot Target (g)', 'Count'),
        config: CONFIG,
    });

    const avgCoasting = mean(rows.map((r) => r.coastingYield));
    plot(chartDiv(row), {
        traces: [{ type: 'histogram', x: rows.map((r) => r.coastingYield), nbinsx: 20, marker: { color: COLOR_WEIGHT } }],
        layout: {
            ...baseLayout('Weight Gained During Coasting', 'Coasting Yield (g)', 'Count'),
            shapes: [vline(avgCoasting, COLOR_TOLERANCE)],
            annotations: [{ x: avgCoasting, y: 1, yref: 'paper', text: `Avg: ${avgCoasting.toFixed(3)}g`, showarrow: false, yanchor: 'bottom' }],
        },
        config: CONFIG,
    });

    plot(chartDiv(row), scatterWithIdentityLine(
        rows.map((r) => ({ sessionId: r.sessionId, x: r.predictiveError, y: r.finalError })),
        'x', 'y', 'Predictive Phase Error vs Final Error', 'Predictive Error (g)', 'Final Error (g)', COLOR_WEIGHT));

    plot(chartDiv(container, 'chart-container small'), {
        traces: [{
            x: rows.map((r) => r.grindLatencyMs), y: rows.map((r) => r.finalError),
            mode: 'markers', marker: { size: 8, opacity: 0.7, color: COLOR_WEIGHT },
            customdata: rows.map((r) => r.sessionId),
            hovertemplate: 'Session %{customdata}<br>Latency: %{x}ms<br>Final Error: %{y:.3f}g<extra></extra>',
        }],
        layout: baseLayout('Grind Latency Impact on Final Accuracy', 'Grind Latency (ms)', 'Final Error (g)'),
        config: CONFIG,
    });
}

function renderPulseMultiTab(container, records, plot) {
    const rows = pulseAnalysis(records);
    if (!rows.length) {
        container.appendChild(infoBox('No pulse data available for the selected sessions.'));
        return;
    }

    container.appendChild(el('p', {
        class: 'table-hint',
        text: 'Each point is one PULSE_EXECUTE event. Pulse duration is calculated as '
            + '(error / pulse_flow_rate); higher correlation between expected and actual yield means '
            + 'better pulse duration predictions.',
    }));

    const r95 = pearson(rows.map((r) => r.expectedYield), rows.map((r) => r.pulseYield));
    const r1500 = pearson(rows.map((r) => r.expectedYield1500), rows.map((r) => r.pulseYield));

    container.appendChild(el('div', { class: 'metric-grid' }, [
        metricTile('Pulses Analyzed', String(rows.length)),
        metricTile('95th Percentile Method', Number.isNaN(r95) ? 'r = n/a' : `r = ${r95.toFixed(3)}`),
        metricTile('1500ms Average Method', Number.isNaN(r1500) ? 'r = n/a' : `r = ${r1500.toFixed(3)}`),
    ]));

    const row = el('div', { class: 'chart-row' });
    container.appendChild(row);

    plot(chartDiv(row), {
        traces: [{
            x: rows.map((r) => r.durationMs), y: rows.map((r) => r.pulseYield),
            mode: 'markers', marker: { size: 8, opacity: 0.6, color: COLOR_WEIGHT },
            customdata: rows.map((r) => r.sessionId),
            hovertemplate: '<b>Session %{customdata}</b><br>Duration: %{x} ms<br>Yield: %{y:.3f}g<extra></extra>',
        }],
        layout: baseLayout('Pulse Duration vs. Weight Added', 'Pulse Duration (ms)', 'Weight Added (g)'),
        config: CONFIG,
    });

    plot(chartDiv(row), scatterWithIdentityLine(
        rows.map((r) => ({ sessionId: r.sessionId, x: r.expectedYield, y: r.pulseYield })),
        'x', 'y',
        `Expected vs. Actual (95th Percentile)${Number.isNaN(r95) ? '' : ` — r = ${r95.toFixed(3)}`}`,
        'Expected Yield (g)', 'Actual Pulse Yield (g)', COLOR_WEIGHT));

    plot(chartDiv(row), scatterWithIdentityLine(
        rows.map((r) => ({ sessionId: r.sessionId, x: r.expectedYield1500, y: r.pulseYield })),
        'x', 'y',
        `Expected vs. Actual (1500ms Average)${Number.isNaN(r1500) ? '' : ` — r = ${r1500.toFixed(3)}`}`,
        'Expected Yield (g)', 'Actual Pulse Yield (g)', COLOR_METHOD_ALT));
}

function renderSessionsTable(container, records) {
    container.appendChild(el('h4', { text: 'Data from Selected Sessions' }));
    const headers = ['ID', 'Profile', 'Target (g)', 'Final (g)', 'Error (g)', 'Pulses', 'Result', 'Motor On (s)', 'Duration (s)'];
    const thead = el('thead', {}, [el('tr', {}, headers.map((h) => el('th', { text: h })))]);
    const tbody = el('tbody', {}, records.map((r) => {
        const s = r.session;
        return el('tr', {}, [
            el('td', { text: `#${s.session_id}` }),
            el('td', { text: PROFILE_MAP[s.profile_id] ?? `P${s.profile_id}` }),
            el('td', { text: s.target_weight.toFixed(2) }),
            el('td', { text: s.final_weight.toFixed(2) }),
            el('td', { text: errorOf(s).toFixed(3) }),
            el('td', { text: String(s.pulse_count) }),
            el('td', { text: s.result_status }),
            el('td', { text: (s.total_motor_on_time_ms / 1000).toFixed(2) }),
            el('td', { text: (s.total_time_ms / 1000).toFixed(2) }),
        ]);
    }));
    container.appendChild(el('div', { class: 'table-scroll' }, [el('table', { class: 'data-table' }, [thead, tbody])]));
}

export const MULTI_TABS = [
    ['overview', 'Session Overview'],
    ['predictive', 'Predictive Analysis'],
    ['pulses', 'Pulse Effectiveness'],
];

// Renders filters + tabs + charts for the multi-session view.
// rerender: callback to re-render the whole view after a filter change.
export function renderMultiView(container, allRecords, multiOptions, plot, rerender) {
    // Filter controls
    const controls = el('div', { class: 'controls-row' });
    const profiles = ['All', ...new Set(allRecords.map((r) => PROFILE_MAP[r.session.profile_id] ?? String(r.session.profile_id)))];
    const addSelect = (labelText, options, current, onChange) => {
        const label = el('label', { class: 'control', text: `${labelText} ` });
        const select = el('select', {});
        for (const option of options) {
            const opt = el('option', { value: option, text: option });
            if (option === current) opt.selected = true;
            select.appendChild(opt);
        }
        select.addEventListener('change', () => { onChange(select.value); rerender(); });
        label.appendChild(select);
        controls.appendChild(label);
    };
    addSelect('Profile', profiles, multiOptions.profile, (v) => { multiOptions.profile = v; });
    addSelect('Mode', ['All', 'Weight', 'Time'], multiOptions.mode, (v) => { multiOptions.mode = v; });

    const ids = allRecords.map((r) => r.session_id);
    const addIdInput = (labelText, key) => {
        const label = el('label', { class: 'control', text: `${labelText} ` });
        const input = el('input', { type: 'number', min: String(Math.min(...ids)), max: String(Math.max(...ids)), value: String(multiOptions[key]) });
        input.style.width = '80px';
        input.addEventListener('change', () => { multiOptions[key] = Number(input.value); rerender(); });
        label.appendChild(input);
        controls.appendChild(label);
    };
    addIdInput('From #', 'idMin');
    addIdInput('To #', 'idMax');
    container.appendChild(controls);

    const filtered = applyMultiFilters(allRecords, multiOptions);
    if (!filtered.length) {
        container.appendChild(infoBox('No sessions match the selected filters.', 'warning'));
        return;
    }

    const modes = new Set(filtered.map((r) => MODE_MAP[r.session.grind_mode] ?? 'WEIGHT'));
    if (modes.size > 1) {
        container.appendChild(infoBox('Mixed grind modes selected. Filter to a single mode to view analytics.', 'warning'));
        renderSessionsTable(container, filtered);
        return;
    }
    if (modes.has('TIME')) {
        container.appendChild(infoBox('Multi-session analytics currently focus on grind-by-weight sessions. '
            + 'Filter to Weight mode to view the predictive and pulse analysis.'));
        renderSessionsTable(container, filtered);
        return;
    }

    // Tab bar
    const tabBar = el('div', { class: 'sub-tabs' });
    for (const [key, label] of MULTI_TABS) {
        const button = el('button', { class: `sub-tab ${multiOptions.tab === key ? 'active' : ''}`, text: label });
        button.addEventListener('click', () => { multiOptions.tab = key; rerender(); });
        tabBar.appendChild(button);
    }
    container.appendChild(tabBar);

    const content = el('div', {});
    container.appendChild(content);
    switch (multiOptions.tab) {
        case 'predictive':
            renderPredictiveMultiTab(content, filtered, plot);
            break;
        case 'pulses':
            renderPulseMultiTab(content, filtered, plot);
            break;
        default:
            renderOverviewTab(content, filtered, plot);
    }

    renderSessionsTable(container, filtered);
}
