// Trends view (long-term drift + wear odometer) and Compare view (aligned
// multi-session weight-curve overlay).
//
// Trends plot per-session metrics against session ID: error, the firmware's
// predictive flow-rate estimate, grind latency, and pulse count — flow decline
// and latency growth are the burr-wear/clogging early-warning signals. The
// odometer row comes from the firmware's lifetime statistics (captured with
// the device health snapshot), so grinds done with logging off still count.

import { MODE_MAP } from './parser.js';
import {
    chartLayout, CHART_CONFIG, COLOR_WEIGHT, COLOR_FLOW, COLOR_TARGET,
    filterForDisplay,
} from './charts.js';
import { isEpochTimestamp } from './app.js';

const TOLERANCE_G = 0.03;
const COLOR_PERFECT = '#0ca30c';

// Sequential blue ramp for the compare overlay, light -> dark. On the dark
// chart surface the lightest step is the most prominent, so the NEWEST
// selected session gets the lightest color and older ones recede.
const RECENCY_RAMP = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec',
    '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab'];
export const COMPARE_MAX_SESSIONS = 10;

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

function metricTile(label, value, delta = null) {
    const children = [
        el('div', { class: 'metric-label', text: label }),
        el('div', { class: 'metric-value', text: value }),
    ];
    if (delta !== null) children.push(el('div', { class: 'metric-delta', text: delta }));
    return el('div', { class: 'metric' }, children);
}

function infoBox(text, type = 'info') {
    return el('div', { class: `status ${type}`, text });
}

function chartDiv(container, cls = 'chart-container small') {
    const div = el('div', { class: cls });
    container.appendChild(div);
    return div;
}

function formatRuntime(totalSeconds) {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
    if (m > 0) return `${m}m ${String(totalSeconds % 60).padStart(2, '0')}s`;
    return `${totalSeconds % 60}s`;
}

function sessionDateLabel(session) {
    return isEpochTimestamp(session.session_timestamp)
        ? new Date(session.session_timestamp * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' })
        : `#${session.session_id}`;
}

// --- Trends ----------------------------------------------------------------

// Per-session trend metrics from weight-mode sessions, in session-id order.
function trendRows(records) {
    const rows = [];
    let cumulativeGrams = 0;
    for (const record of records) {
        const s = record.session;
        if ((MODE_MAP[s.grind_mode] ?? 'WEIGHT') !== 'WEIGHT') continue;
        cumulativeGrams += Math.max(0, s.final_weight);
        const predictive = record.events.find((e) => e.phase_name === 'PREDICTIVE');
        rows.push({
            sessionId: s.session_id,
            date: sessionDateLabel(s),
            error: s.final_weight - s.target_weight,
            flowRate: predictive ? predictive.pulse_flow_rate : null,
            latencyMs: predictive ? predictive.grind_latency_ms : null,
            pulses: s.pulse_count,
            cumGrams: cumulativeGrams,
        });
    }
    return rows;
}

function trendFigure(rows, valueKey, title, yTitle, options = {}) {
    const points = rows.filter((r) => r[valueKey] !== null && r[valueKey] !== undefined);
    const layout = chartLayout(title, 'Session ID', yTitle);
    if (options.shapes) layout.shapes = options.shapes;
    return {
        traces: [{
            x: points.map((r) => r.sessionId),
            y: points.map((r) => r[valueKey]),
            mode: 'lines+markers',
            marker: { size: 7, color: COLOR_WEIGHT },
            line: { color: 'rgba(57,135,229,0.35)', width: 1.5 },
            customdata: points.map((r) => [r.date, r.cumGrams.toFixed(0)]),
            hovertemplate: `Session %{x} (%{customdata[0]})<br>${yTitle}: %{y:.3f}`
                + '<br>Cumulative: %{customdata[1]} g ground<extra></extra>',
        }],
        layout,
        config: CHART_CONFIG,
    };
}

function hline(y, color, dash = 'dash') {
    return { type: 'line', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: y, y1: y, line: { color, width: 1.5, dash } };
}

export function renderTrendsView(container, records, deviceReports, plot) {
    // Wear odometer from the firmware's lifetime statistics: counts every
    // grind ever done on this device, not just the logged sessions below.
    const lifetime = deviceReports?.system_info?.sessions?.lifetime;
    if (lifetime) {
        container.appendChild(el('h4', { text: 'Lifetime (device odometer)' }));
        container.appendChild(el('div', { class: 'metric-grid' }, [
            metricTile('Coffee Through Burrs', `${(lifetime.total_weight_kg ?? 0).toFixed(2)} kg`,
                'typical burr life is quoted in kg'),
            metricTile('Total Grinds', String(lifetime.total_grinds ?? 0),
                `${lifetime.weight_mode_grinds ?? 0} weight · ${lifetime.time_mode_grinds ?? 0} time`),
            metricTile('Motor Runtime', formatRuntime(lifetime.motor_runtime_sec ?? 0)),
            metricTile('Total Pulses', String(lifetime.total_pulses ?? 0)),
            metricTile('Avg |Error|', `${(lifetime.avg_accuracy_g ?? 0).toFixed(3)} g`),
        ]));
    } else {
        container.appendChild(infoBox('No lifetime statistics captured yet — pull data from a grinder '
            + 'running firmware with the extended health snapshot to see the wear odometer.'));
    }

    const rows = trendRows(records);
    if (rows.length < 2) {
        container.appendChild(infoBox('Trends need at least two logged weight-mode sessions.'));
        return;
    }

    container.appendChild(el('h4', { text: `Drift across ${rows.length} logged sessions` }));
    container.appendChild(el('p', {
        class: 'table-hint',
        text: 'Watch for flow rate declining and grind latency growing over time — both are early '
            + 'signs of burr wear or clogging. Error and pulse count show whether the controller is compensating.',
    }));

    const grid = el('div', { class: 'chart-row' });
    container.appendChild(grid);

    plot(chartDiv(grid), trendFigure(rows, 'error', 'Weight Error', 'Error (g)', {
        shapes: [hline(TOLERANCE_G, COLOR_TARGET), hline(-TOLERANCE_G, COLOR_TARGET), hline(0, COLOR_PERFECT, 'solid')],
    }));
    plot(chartDiv(grid), trendFigure(rows, 'flowRate', 'Predictive Flow Rate', 'Flow (g/s)'));
    plot(chartDiv(grid), trendFigure(rows, 'latencyMs', 'Grind Latency', 'Latency (ms)'));
    plot(chartDiv(grid), trendFigure(rows, 'pulses', 'Pulse Count', 'Pulses'));
}

// --- Compare ---------------------------------------------------------------

// Alignment origin: start of the main grind (PREDICTIVE for weight mode,
// TIME_GRINDING for time mode), falling back to the first measurement.
function alignmentOrigin(record) {
    const main = record.events.find((e) => e.phase_name === 'PREDICTIVE')
        || record.events.find((e) => e.phase_name === 'TIME_GRINDING');
    if (main) return main.timestamp_ms;
    const displayed = filterForDisplay(record.measurements, false);
    return displayed.length ? displayed[0].timestamp_ms : 0;
}

function buildCompareFigure(selectedRecords, showFlow) {
    // Newest first so the ramp assigns the lightest (most prominent) color to
    // the most recent grind; older curves recede into darker blues.
    const sorted = [...selectedRecords].sort((a, b) => b.session_id - a.session_id);
    const traces = [];

    sorted.forEach((record, rank) => {
        const color = RECENCY_RAMP[Math.min(rank, RECENCY_RAMP.length - 1)];
        const t0 = alignmentOrigin(record);
        const measurements = record.measurements
            .filter((m) => m.timestamp_ms >= t0)
            .sort((a, b) => a.timestamp_ms - b.timestamp_ms);
        const xs = measurements.map((m) => m.timestamp_ms - t0);
        traces.push({
            x: xs,
            y: measurements.map((m) => m.weight_grams),
            mode: 'lines', name: `#${record.session_id}`,
            line: { color, width: rank === 0 ? 2.5 : 1.5 },
            hovertemplate: `#${record.session_id}: %{y:.2f}g at %{x}ms<extra></extra>`,
        });
        if (showFlow) {
            traces.push({
                x: xs,
                y: measurements.map((m) => m.flow_rate_g_per_s),
                mode: 'lines', name: `#${record.session_id} flow`,
                line: { color, width: 1, dash: 'dot' }, yaxis: 'y2',
                showlegend: false,
                hovertemplate: `#${record.session_id} flow: %{y:.2f}g/s<extra></extra>`,
            });
        }
    });

    const layout = chartLayout('Aligned Grind Curves (t=0 at grind start)', 'Time from grind start (ms)', 'Weight (g)');
    layout.showlegend = true;
    layout.legend = { yanchor: 'top', y: 0.99, xanchor: 'left', x: 0.01, bgcolor: 'rgba(10,12,16,0.75)' };
    if (showFlow) {
        layout.yaxis2 = { title: { text: 'Flow (g/s)' }, overlaying: 'y', side: 'right', showgrid: false, zeroline: false };
    }

    // Single shared target line when every selected session aims at the same weight.
    const targets = new Set(sorted
        .filter((r) => (MODE_MAP[r.session.grind_mode] ?? 'WEIGHT') === 'WEIGHT')
        .map((r) => r.session.target_weight.toFixed(2)));
    if (targets.size === 1 && sorted.length) {
        const target = Number([...targets][0]);
        layout.shapes = [{
            type: 'line', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: target, y1: target,
            line: { color: COLOR_TARGET, width: 1.5, dash: 'dash' },
        }];
        layout.annotations = [{
            xref: 'paper', yref: 'y', x: 0.99, y: target, text: 'Target',
            showarrow: false, yanchor: 'bottom', font: { size: 11, color: COLOR_TARGET },
        }];
    }

    return { traces, layout, config: CHART_CONFIG };
}

// compareOptions: { selected: Set<sessionId>, showFlow: bool, initialized: bool }
export function renderCompareView(container, records, compareOptions, plot, rerender) {
    if (!records.length) {
        container.appendChild(infoBox('No sessions stored yet.'));
        return;
    }

    // First visit: preselect the two newest sessions so the chart isn't empty.
    if (!compareOptions.initialized) {
        compareOptions.initialized = true;
        for (const record of records.slice(-2)) compareOptions.selected.add(record.session_id);
    }
    // Drop selections that no longer exist (cleared/re-pulled data).
    for (const id of [...compareOptions.selected]) {
        if (!records.some((r) => r.session_id === id)) compareOptions.selected.delete(id);
    }

    const selectedRecords = records.filter((r) => compareOptions.selected.has(r.session_id));

    const controls = el('div', { class: 'controls-row' });
    controls.appendChild(el('span', {
        class: 'control',
        text: `${selectedRecords.length}/${COMPARE_MAX_SESSIONS} sessions selected`,
    }));
    const flowLabel = el('label', { class: 'control' });
    const flowBox = el('input', { type: 'checkbox' });
    flowBox.checked = compareOptions.showFlow;
    flowBox.addEventListener('change', () => {
        compareOptions.showFlow = flowBox.checked;
        rerender();
    });
    flowLabel.appendChild(flowBox);
    flowLabel.appendChild(document.createTextNode(' Show flow rate'));
    controls.appendChild(flowLabel);
    container.appendChild(controls);

    if (selectedRecords.length) {
        plot(chartDiv(container, 'chart-container'), buildCompareFigure(selectedRecords, compareOptions.showFlow));
    } else {
        container.appendChild(infoBox('Select sessions below to overlay their grind curves.'));
    }

    // Selection table, newest first.
    const headers = ['', 'ID', 'Started', 'Mode', 'Target', 'Final (g)', 'Error', 'Result'];
    const thead = el('thead', {}, [el('tr', {}, headers.map((h) => el('th', { text: h })))]);
    const atCap = compareOptions.selected.size >= COMPARE_MAX_SESSIONS;
    const rows = [...records].reverse().map((record) => {
        const s = record.session;
        const checked = compareOptions.selected.has(s.session_id);
        const box = el('input', { type: 'checkbox' });
        box.checked = checked;
        if (!checked && atCap) box.disabled = true;
        box.addEventListener('change', () => {
            if (box.checked) compareOptions.selected.add(s.session_id);
            else compareOptions.selected.delete(s.session_id);
            rerender();
        });
        const mode = MODE_MAP[s.grind_mode] ?? 'WEIGHT';
        const error = mode === 'TIME'
            ? `${(s.time_error_ms / 1000 >= 0 ? '+' : '')}${(s.time_error_ms / 1000).toFixed(2)}s`
            : `${s.final_weight - s.target_weight >= 0 ? '+' : ''}${(s.final_weight - s.target_weight).toFixed(2)}g`;
        const target = mode === 'TIME' ? `${(s.target_time_ms / 1000).toFixed(1)}s` : `${s.target_weight.toFixed(1)}g`;
        const started = isEpochTimestamp(s.session_timestamp)
            ? new Date(s.session_timestamp * 1000).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
            : 'uptime only';
        const row = el('tr', { class: checked ? 'selected' : '' }, [
            el('td', {}, [box]),
            el('td', { text: `#${s.session_id}` }),
            el('td', { text: started }),
            el('td', { text: mode }),
            el('td', { text: target }),
            el('td', { text: s.final_weight.toFixed(2) }),
            el('td', { text: error }),
            el('td', { text: s.result_status }),
        ]);
        return row;
    });
    container.appendChild(el('div', { class: 'table-scroll tall' }, [
        el('table', { class: 'data-table' }, [thead, el('tbody', {}, rows)]),
    ]));
}
