// Analytics tab controller: pull data over BLE, persist it, and render the
// session browser. Chart views arrive in later milestones and will hang off
// the same stored records.

import { GrinderDataClient, isWebBluetoothSupported } from './ble-data.js';
import { MODE_MAP, PROFILE_MAP, TERMINATION_REASON_MAP } from './parser.js';
import { mean, stddev } from './frame.js';
import {
    saveSessions, loadSessions, clearAll, saveMeta, loadMeta,
    buildExportJson, parseImportJson,
} from './store.js';
import {
    buildOverviewFigure, filterForDisplay, grindTimeSeconds,
    DEFAULT_HIDDEN_PHASES, PHASE_DESCRIPTIONS,
} from './charts.js';
import { renderPredictiveTab, renderPulseTab, renderVibrationTab, renderControllerTab } from './views-single.js';
import { renderMultiView } from './views-multi.js';
import { renderDeviceHealth } from './views-health.js';
import { renderTrendsView, renderCompareView } from './views-trends.js';
import {
    getCloudConfig, saveCloudConfig, clearCloudConfig, createCloudStore, deleteCloudStore,
    adoptShareFragment, buildShareLink, pullFromCloud, pushToCloud, pushSnapshotToCloud,
} from './cloud.js';

const TOLERANCE_G = 0.03; // grind accuracy tolerance, as in the Streamlit report
const PLOTLY_CDN = 'https://cdn.plot.ly/plotly-2.35.2.min.js';

let records = [];
let selectedSessionId = null;
let deviceReports = null;

// Chart view options, shared across sessions like the Streamlit sidebar state.
const viewOptions = {
    includeTaring: false,
    smoothingMs: 500,
    hiddenPhases: new Set(DEFAULT_HIDDEN_PHASES),
    detailTab: 'overall',
    vibration: { showIir: false, alpha: 0.25, showNotch: false, notchFreq: 0.2, q: 5 },
    analysisMode: 'single',
    multi: { profile: 'All', mode: 'All', idMin: 0, idMax: 0, tab: 'overview' },
    compare: { selected: new Set(), showFlow: false, initialized: false },
    tableExpanded: false,
};

const DETAIL_TABS = [
    ['overall', 'Overall'],
    ['predictive', 'Predictive Phase'],
    ['pulse', 'Pulse Phase'],
    ['vibration', 'Vibration'],
    ['controller', 'Controller'],
];

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Failed to load ${src}`));
        document.head.appendChild(script);
    });
}

// Plotly is vendored so the analytics tab works offline; the CDN is only a
// fallback for deployments that strip the vendor directory.
let plotlyPromise = null;
function loadPlotly() {
    if (window.Plotly) return Promise.resolve(window.Plotly);
    if (!plotlyPromise) {
        plotlyPromise = loadScript('vendor/plotly.min.js')
            .catch(() => loadScript(PLOTLY_CDN))
            .then(() => {
                if (!window.Plotly) throw new Error('Failed to load the Plotly chart library');
                return window.Plotly;
            });
    }
    return plotlyPromise;
}

const $ = (id) => document.getElementById(id);

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

function setStatus(message, type = 'info') {
    const status = $('analyticsStatus');
    status.textContent = message;
    status.className = `status ${type}`;
    status.style.display = message ? 'block' : 'none';
}

function setProgress(percent) {
    const container = $('analyticsProgressContainer');
    if (percent === null) {
        container.style.display = 'none';
        return;
    }
    container.style.display = 'block';
    $('analyticsProgressBar').style.width = `${percent}%`;
}

// Device status notifications arrive with every 512-byte chunk (up to ~40/s).
// Throttle the resulting DOM writes so the main thread stays free to service
// incoming BLE notification events during a transfer.
let lastProgressUpdate = 0;
function setProgressThrottled(percent) {
    const now = Date.now();
    if (now - lastProgressUpdate < 100) return;
    lastProgressUpdate = now;
    setProgress(percent);
}

function formatUptime(totalSeconds) {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// session_timestamp carries a real Unix epoch once the device clock has been
// synced over BLE, and uptime seconds otherwise. Distinguish by magnitude
// (2020-01-01 epoch is far above any plausible uptime).
const EPOCH_THRESHOLD = 1577836800;

export function isEpochTimestamp(ts) {
    return ts >= EPOCH_THRESHOLD;
}

function sessionStartLabel(session) {
    const ts = session.session_timestamp;
    if (isEpochTimestamp(ts)) {
        return new Date(ts * 1000).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
    }
    return `${formatUptime(ts)} uptime`;
}

function sessionTargetLabel(session) {
    if (MODE_MAP[session.grind_mode] === 'TIME') {
        return `${(session.target_time_ms / 1000).toFixed(1)}s`;
    }
    return `${session.target_weight.toFixed(1)}g`;
}

function sessionErrorLabel(session) {
    if (MODE_MAP[session.grind_mode] === 'TIME') {
        return `${(session.time_error_ms / 1000 >= 0 ? '+' : '')}${(session.time_error_ms / 1000).toFixed(2)}s`;
    }
    const error = session.final_weight - session.target_weight;
    return `${error >= 0 ? '+' : ''}${error.toFixed(2)}g`;
}

async function refreshFromStore() {
    records = await loadSessions();
    deviceReports = await loadMeta('deviceReports');
    if (records.length) {
        viewOptions.multi.idMin = Math.min(...records.map((r) => r.session_id));
        viewOptions.multi.idMax = Math.max(...records.map((r) => r.session_id));
        // Open on the newest session so the overview chart is visible without
        // an extra click.
        if (selectedSessionId === null || !records.some((r) => r.session_id === selectedSessionId)) {
            selectedSessionId = records[records.length - 1].session_id;
        }
    }
    renderSummary();
    renderMain();
}

// Result status → reserved status palette kind (badge classes in index.html).
function badgeKind(status) {
    switch (status) {
        case 'COMPLETE': return 'good';
        case 'OVERSHOOT': return 'warning';
        case 'MAX_PULSES': return 'serious';
        case 'TIMEOUT': return 'critical';
        default: return 'neutral';
    }
}

function resultBadge(status) {
    return el('span', { class: `badge st-${badgeKind(status)}`, text: status });
}

function renderMain() {
    const sessionsContainer = $('analyticsSessionsContainer');
    const detailContainer = $('analyticsDetailContainer');
    sessionsContainer.textContent = '';
    detailContainer.textContent = '';
    if (!records.length && !deviceReports) return;

    const modes = [
        ['single', 'Single Session'],
        ['compare', 'Compare'],
        ['multi', 'Multi-Session'],
        ['trends', 'Trends'],
        ['health', 'Device Health'],
    ];
    const switcher = el('div', { class: 'sub-tabs' });
    for (const [key, label] of modes) {
        const button = el('button', { class: `sub-tab ${viewOptions.analysisMode === key ? 'active' : ''}`, text: label });
        button.addEventListener('click', () => {
            viewOptions.analysisMode = key;
            renderMain();
        });
        switcher.appendChild(button);
    }
    sessionsContainer.appendChild(switcher);

    if (viewOptions.analysisMode === 'health') {
        const host = el('div', {});
        sessionsContainer.appendChild(host);
        renderDeviceHealth(host, deviceReports);
    } else if (!records.length) {
        sessionsContainer.appendChild(el('div', { class: 'status info', text: 'No grind sessions stored yet.' }));
    } else if (viewOptions.analysisMode === 'multi') {
        const host = el('div', {});
        sessionsContainer.appendChild(host);
        renderMultiView(host, records, viewOptions.multi, plot, renderMain);
    } else if (viewOptions.analysisMode === 'trends') {
        const host = el('div', {});
        sessionsContainer.appendChild(host);
        renderTrendsView(host, records, deviceReports, plot);
    } else if (viewOptions.analysisMode === 'compare') {
        const host = el('div', {});
        sessionsContainer.appendChild(host);
        renderCompareView(host, records, viewOptions.compare, plot, renderMain);
    } else {
        renderSessionsTable(sessionsContainer);
        renderDetail();
    }
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    return node;
}

// Miniature of the multi-session "Error vs Session ID" chart: one point per
// weight-mode grind, tolerance guides in red, zero line in green. Points
// outside tolerance are red as well as outside the band (double encoding).
function buildErrorSparkline(weightRecords) {
    const W = 600;
    const H = 52;
    const PAD = 8;
    const points = weightRecords.map((r) => ({
        id: r.session_id,
        error: r.session.final_weight - r.session.target_weight,
    }));
    const maxAbs = Math.max(TOLERANCE_G * 1.6, ...points.map((p) => Math.abs(p.error)));
    const y = (v) => H / 2 - (v / maxAbs) * (H / 2 - PAD);
    const x = (i) => (points.length === 1 ? W / 2 : PAD + (i / (points.length - 1)) * (W - 2 * PAD));

    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Weight error per session' });
    svg.appendChild(svgEl('line', { x1: 0, x2: W, y1: y(0), y2: y(0), stroke: '#0ca30c', 'stroke-width': 1, opacity: 0.5 }));
    for (const tol of [TOLERANCE_G, -TOLERANCE_G]) {
        svg.appendChild(svgEl('line', {
            x1: 0, x2: W, y1: y(tol), y2: y(tol),
            stroke: '#e66767', 'stroke-width': 1, 'stroke-dasharray': '4 4', opacity: 0.6,
        }));
    }
    if (points.length > 1) {
        svg.appendChild(svgEl('polyline', {
            points: points.map((p, i) => `${x(i)},${y(p.error)}`).join(' '),
            fill: 'none', stroke: 'rgba(57,135,229,0.35)', 'stroke-width': 1.5,
        }));
    }
    points.forEach((p, i) => {
        const within = Math.abs(p.error) < TOLERANCE_G;
        const dot = svgEl('circle', {
            cx: x(i), cy: y(p.error), r: 3.5,
            fill: within ? '#3987e5' : '#d03b3b',
        });
        const title = svgEl('title');
        title.textContent = `#${p.id}: ${p.error >= 0 ? '+' : ''}${p.error.toFixed(3)} g`;
        dot.appendChild(title);
        svg.appendChild(dot);
    });
    return svg;
}

// Left hero panel: the newest grind, presented like the device's completion
// screen — big final weight, target and signed error.
function buildLatestPanel(record) {
    const s = record.session;
    const mode = MODE_MAP[s.grind_mode] ?? 'WEIGHT';
    const panel = el('div', { class: 'hero-latest' });

    const sessionLine = el('div', { class: 'session-line' }, [
        el('span', { text: `LATEST · #${s.session_id}` }),
        el('span', { text: mode }),
        el('span', { text: PROFILE_MAP[s.profile_id] ?? `P${s.profile_id}` }),
    ]);
    if (isEpochTimestamp(s.session_timestamp)) {
        sessionLine.appendChild(el('span', { text: sessionStartLabel(s) }));
    }
    panel.appendChild(sessionLine);

    const weight = el('div', { class: 'hero-weight' });
    weight.appendChild(document.createTextNode(s.final_weight.toFixed(2)));
    weight.appendChild(el('span', { class: 'unit', text: ' g' }));
    panel.appendChild(weight);

    const target = el('div', { class: 'hero-target' });
    target.appendChild(document.createTextNode(`target ${sessionTargetLabel(s)} · `));
    let errorClass = '';
    if (mode === 'WEIGHT') {
        errorClass = Math.abs(s.final_weight - s.target_weight) < TOLERANCE_G ? 'good' : 'bad';
    }
    target.appendChild(el('span', { class: `hero-error ${errorClass}`, text: sessionErrorLabel(s) }));
    panel.appendChild(target);

    const grindTime = grindTimeSeconds(record.events);
    const activeSeconds = grindTime > 0 ? grindTime : s.total_time_ms / 1000;
    const fact = (valueNode, label) => el('div', {}, [valueNode, document.createTextNode(label)]);
    panel.appendChild(el('div', { class: 'hero-facts' }, [
        fact(el('b', { text: `${activeSeconds.toFixed(1)} s` }), 'grind time'),
        fact(el('b', { text: String(s.pulse_count) }), 'pulses'),
        fact(el('b', {}, [resultBadge(s.result_status)]), 'result'),
    ]));
    return panel;
}

// Right hero panel: KPIs across every stored session + the error sparkline.
function buildFleetPanel() {
    const wrap = el('div', { class: 'hero-fleet' });
    const weightRecords = records.filter((r) => (MODE_MAP[r.session.grind_mode] ?? 'WEIGHT') === 'WEIGHT');

    const tiles = [metricTile('Sessions', String(records.length))];
    if (weightRecords.length) {
        const errors = weightRecords.map((r) => r.session.final_weight - r.session.target_weight);
        const within = errors.filter((e) => Math.abs(e) < TOLERANCE_G).length;
        const grindTimes = weightRecords.map((r) => grindTimeSeconds(r.events)).filter((t) => t > 0);
        const meanError = mean(errors);
        const sigma = stddev(errors);
        tiles.push(
            metricTile(`Within ±${TOLERANCE_G.toFixed(2)} g`, `${((within / errors.length) * 100).toFixed(0)}%`,
                `${within}/${errors.length} grinds`),
            metricTile('Mean Error', `${meanError >= 0 ? '+' : ''}${meanError.toFixed(3)} g`),
            metricTile('Error σ', Number.isNaN(sigma) ? 'n/a' : `${sigma.toFixed(3)} g`),
            metricTile('Avg Grind Time', grindTimes.length ? `${mean(grindTimes).toFixed(1)} s` : 'n/a'),
        );
    }
    const kpiRow = el('div', { class: 'kpi-row' }, tiles);
    kpiRow.style.margin = '0';
    wrap.appendChild(kpiRow);

    if (weightRecords.length >= 2) {
        const spark = el('div', { class: 'sparkline-block' });
        spark.appendChild(el('div', { class: 'spark-label', text: `error per session (g) · ±${TOLERANCE_G.toFixed(2)} band` }));
        spark.appendChild(buildErrorSparkline(weightRecords));
        wrap.appendChild(spark);
    }
    return wrap;
}

async function renderSummary() {
    const summary = $('analyticsSummary');
    summary.textContent = '';

    const grinderSnapshot = window.GrinderSession?.getActive?.()?.snapshot || null;

    // Grind logging is a device-side toggle; when it's off the grinder records
    // nothing, so surface that loudly instead of letting data silently vanish.
    // Checked in both the last pull's health report and the (possibly fresher)
    // grinder card snapshot.
    if (deviceReports?.system_info?.sessions?.logging_enabled === false
        || grinderSnapshot?.sessions?.logging_enabled === false) {
        summary.appendChild(el('div', {
            class: 'status warning',
            text: 'Grind logging is OFF on the device — grinds are not being recorded. '
                + 'Enable it under Menu → Logs & Data on the grinder.',
        }));
    }

    if (!records.length) {
        const deviceSessions = grinderSnapshot?.sessions?.total_sessions;
        summary.appendChild(el('div', {
            class: 'status info',
            text: deviceSessions
                ? `No grind data stored in this browser yet — your grinder has ${deviceSessions} sessions ready to pull.`
                : 'No grind data stored yet. Pull data from the grinder or import a JSON export.',
        }));
        return;
    }
    const lastPull = await loadMeta('lastPull');

    const hero = el('div', { class: 'hero' });
    hero.appendChild(buildLatestPanel(records[records.length - 1]));
    hero.appendChild(buildFleetPanel());
    summary.appendChild(hero);

    const totalEvents = records.reduce((sum, r) => sum + r.events.length, 0);
    const totalMeasurements = records.reduce((sum, r) => sum + r.measurements.length, 0);
    const deviceSessions = grinderSnapshot?.sessions?.total_sessions;
    summary.appendChild(el('div', {
        class: 'store-line',
        text: `${records.length} sessions · ${totalEvents.toLocaleString()} events · ${totalMeasurements.toLocaleString()} measurements stored in this browser`
            + (lastPull ? ` · last pull ${new Date(lastPull).toLocaleString()}` : '')
            + (deviceSessions !== undefined ? ` · grinder holds ${deviceSessions} sessions` : ''),
    }));
}

const TABLE_ROW_LIMIT = 25;

function renderSessionsTable(container) {
    if (!records.length) return;

    const headers = ['ID', 'Started', 'Mode', 'Profile', 'Target', 'Final (g)', 'Error', 'Pulses', 'Result', 'Events', 'Samples'];
    const thead = el('thead', {}, [el('tr', {}, headers.map((h) => el('th', { text: h })))]);

    // Newest first; recent grinds are what gets scanned. KPIs, sparkline and
    // trends always compute over the full set regardless of this cap.
    const newestFirst = [...records].reverse();
    const visibleRecords = viewOptions.tableExpanded ? newestFirst : newestFirst.slice(0, TABLE_ROW_LIMIT);

    const rows = visibleRecords.map((record) => {
        const s = record.session;
        const errorCell = el('td', { text: sessionErrorLabel(s) });
        if ((MODE_MAP[s.grind_mode] ?? 'WEIGHT') === 'WEIGHT') {
            errorCell.className = Math.abs(s.final_weight - s.target_weight) < TOLERANCE_G ? 'num-good' : 'num-bad';
        }
        const row = el('tr', { class: s.session_id === selectedSessionId ? 'selected' : '' }, [
            el('td', { text: `#${s.session_id}` }),
            el('td', { text: sessionStartLabel(s) }),
            el('td', { text: MODE_MAP[s.grind_mode] ?? 'UNKNOWN' }),
            el('td', { text: PROFILE_MAP[s.profile_id] ?? `P${s.profile_id}` }),
            el('td', { text: sessionTargetLabel(s) }),
            el('td', { text: s.final_weight.toFixed(2) }),
            errorCell,
            el('td', { text: String(s.pulse_count) }),
            el('td', {}, [resultBadge(s.result_status)]),
            el('td', { text: String(record.events.length) }),
            el('td', { text: String(record.measurements.length) }),
        ]);
        row.addEventListener('click', () => {
            selectedSessionId = s.session_id === selectedSessionId ? null : s.session_id;
            renderMain();
        });
        return row;
    });

    container.appendChild(el('h3', { text: 'Grind Sessions' }));
    container.appendChild(el('p', { class: 'table-hint', text: 'Click a session to open its full analysis below.' }));
    const wrapper = el('div', { class: 'table-scroll' }, [el('table', { class: 'data-table' }, [thead, el('tbody', {}, rows)])]);
    container.appendChild(wrapper);

    if (records.length > TABLE_ROW_LIMIT) {
        const toggle = el('button', {
            class: 'btn-ghost',
            text: viewOptions.tableExpanded
                ? `Show latest ${TABLE_ROW_LIMIT} only`
                : `Show all ${records.length} sessions`,
        });
        toggle.addEventListener('click', () => {
            viewOptions.tableExpanded = !viewOptions.tableExpanded;
            renderMain();
        });
        container.appendChild(toggle);
    }
}

function buildRawTable(items, columns) {
    const thead = el('thead', {}, [el('tr', {}, columns.map((c) => el('th', { text: c })))]);
    const rows = items.map((item) => el('tr', {}, columns.map((c) => {
        const value = item[c];
        const text = typeof value === 'number' && !Number.isInteger(value) ? value.toFixed(4) : String(value);
        return el('td', { text });
    })));
    return el('div', { class: 'table-scroll tall' }, [el('table', { class: 'data-table' }, [thead, el('tbody', {}, rows)])]);
}

function metricTile(label, value, delta = null, deltaClass = '') {
    const children = [
        el('div', { class: 'metric-label', text: label }),
        el('div', { class: 'metric-value', text: value }),
    ];
    if (delta !== null) {
        children.push(el('div', { class: `metric-delta ${deltaClass}`, text: delta }));
    }
    return el('div', { class: 'metric' }, children);
}

function buildMetricsGrid(record) {
    const s = record.session;
    const mode = MODE_MAP[s.grind_mode] ?? 'WEIGHT';
    const measurements = filterForDisplay(record.measurements, viewOptions.includeTaring);
    const grindTime = grindTimeSeconds(record.events);
    const resolution = grindTime > 0 ? (measurements.length / grindTime).toFixed(1) : '0';

    const tiles = [];
    if (mode === 'TIME') {
        const timeErrorS = s.time_error_ms / 1000;
        tiles.push(
            metricTile('Target Time (s)', (s.target_time_ms / 1000).toFixed(2),
                `${timeErrorS >= 0 ? '+' : ''}${timeErrorS.toFixed(2)} s`, timeErrorS > 0 ? 'bad' : 'good'),
            metricTile('Motor On Time (s)', (s.total_motor_on_time_ms / 1000).toFixed(2)),
            metricTile('Session Duration (s)', (s.total_time_ms / 1000).toFixed(2)),
            metricTile('Termination', TERMINATION_REASON_MAP[s.termination_reason] ?? s.result_status),
            metricTile('Final Weight (g)', s.final_weight.toFixed(2)),
            metricTile('Data Resolution', `${resolution} meas/sec`),
        );
    } else {
        const error = s.final_weight - s.target_weight;
        const withinTolerance = Math.abs(error) < TOLERANCE_G;
        tiles.push(
            metricTile('Target (g)', s.target_weight.toFixed(2),
                `${error >= 0 ? '+' : ''}${error.toFixed(2)} g`, withinTolerance ? 'good' : 'bad'),
            metricTile('Final (g)', s.final_weight.toFixed(2)),
            metricTile('Grind Time (s)', grindTime.toFixed(1)),
            metricTile('Result', s.result_status),
            metricTile('Pulse Count', String(s.pulse_count)),
            metricTile('Data Resolution', `${resolution} meas/sec`),
        );
    }
    return el('div', { class: 'metric-grid' }, tiles);
}

// Shared controls (taring + smoothing) apply to every analysis tab; the
// per-phase marker toggles are specific to the overview chart.
function buildSharedControls(onChange) {
    const controls = el('div', { class: 'controls-row' });

    const taringLabel = el('label', { class: 'control' });
    const taringBox = el('input', { type: 'checkbox' });
    taringBox.checked = viewOptions.includeTaring;
    taringBox.addEventListener('change', () => {
        viewOptions.includeTaring = taringBox.checked;
        onChange();
    });
    taringLabel.appendChild(taringBox);
    taringLabel.appendChild(document.createTextNode(' Include taring'));
    controls.appendChild(taringLabel);

    const smoothingLabel = el('label', { class: 'control', text: 'Flow smoothing ' });
    const smoothingSelect = el('select', {});
    for (const [label, value] of [['None', 0], ['100 ms', 100], ['500 ms', 500], ['1000 ms', 1000], ['1500 ms', 1500]]) {
        const option = el('option', { value: String(value), text: label });
        if (value === viewOptions.smoothingMs) option.selected = true;
        smoothingSelect.appendChild(option);
    }
    smoothingSelect.addEventListener('change', () => {
        viewOptions.smoothingMs = Number(smoothingSelect.value);
        onChange();
    });
    smoothingLabel.appendChild(smoothingSelect);
    controls.appendChild(smoothingLabel);

    return controls;
}

function buildPhaseToggles(record, onChange) {
    const controls = el('div', { class: 'controls-row' });
    controls.appendChild(el('span', { class: 'control', text: 'Event markers:' }));
    const phases = [...new Set(filterForDisplay(record.events, viewOptions.includeTaring).map((e) => e.phase_name))].sort();
    for (const phase of phases) {
        const label = el('label', { class: 'control', title: PHASE_DESCRIPTIONS[phase] || phase });
        const box = el('input', { type: 'checkbox' });
        box.checked = !viewOptions.hiddenPhases.has(phase);
        box.addEventListener('change', () => {
            if (box.checked) viewOptions.hiddenPhases.delete(phase);
            else viewOptions.hiddenPhases.add(phase);
            onChange();
        });
        label.appendChild(box);
        label.appendChild(document.createTextNode(` ${phase}`));
        controls.appendChild(label);
    }
    return controls;
}

// Renders a Plotly figure into a div, loading the library on first use.
async function plot(div, figure) {
    try {
        const Plotly = await loadPlotly();
        await Plotly.react(div, figure.traces, figure.layout, figure.config);
    } catch (error) {
        div.textContent = `Chart unavailable: ${error.message}`;
        console.error('Chart render error:', error);
    }
}

function renderOverviewChart(record) {
    const chartDiv = $('analyticsChart');
    if (!chartDiv) return;
    const phases = [...new Set(filterForDisplay(record.events, viewOptions.includeTaring).map((e) => e.phase_name))];
    const visiblePhases = phases.filter((p) => !viewOptions.hiddenPhases.has(p));
    plot(chartDiv, buildOverviewFigure(record, {
        includeTaring: viewOptions.includeTaring,
        smoothingMs: viewOptions.smoothingMs,
        visiblePhases,
    }));
}

function renderOverallTab(container, record) {
    container.appendChild(buildMetricsGrid(record));
    container.appendChild(buildPhaseToggles(record, () => renderOverviewChart(record)));
    container.appendChild(el('div', { id: 'analyticsChart', class: 'chart-container' }));
    container.appendChild(buildRawDataSection(record));
    renderOverviewChart(record);
}

function renderDetail() {
    const container = $('analyticsDetailContainer');
    container.textContent = '';
    if (selectedSessionId === null) return;
    const record = records.find((r) => r.session_id === selectedSessionId);
    if (!record) return;

    container.appendChild(el('h3', { text: `Session #${record.session_id} — Analysis` }));
    container.appendChild(buildSharedControls(renderDetail));

    // Sub-tab bar mirroring the Streamlit report's tab layout
    const tabBar = el('div', { class: 'sub-tabs' });
    for (const [key, label] of DETAIL_TABS) {
        const button = el('button', { class: `sub-tab ${viewOptions.detailTab === key ? 'active' : ''}`, text: label });
        button.addEventListener('click', () => {
            viewOptions.detailTab = key;
            renderDetail();
        });
        tabBar.appendChild(button);
    }
    container.appendChild(tabBar);

    const content = el('div', {});
    container.appendChild(content);

    switch (viewOptions.detailTab) {
        case 'predictive':
            renderPredictiveTab(content, record, viewOptions, plot);
            break;
        case 'pulse':
            renderPulseTab(content, record, viewOptions, plot);
            break;
        case 'vibration':
            renderVibrationTab(content, record, viewOptions, plot);
            break;
        case 'controller':
            renderControllerTab(content, record, viewOptions);
            break;
        default:
            renderOverallTab(content, record);
    }
}

function buildRawDataSection(record) {
    const rawDetails = el('details', {}, [el('summary', { text: 'Raw data for this session' })]);
    const sessionRows = Object.entries(record.session).map(([key, value]) => el('tr', {}, [
        el('th', { text: key }),
        el('td', { text: typeof value === 'number' && !Number.isInteger(value) ? value.toFixed(4) : String(value) }),
    ]));
    rawDetails.appendChild(el('div', { class: 'table-scroll' }, [el('table', { class: 'data-table' }, [el('tbody', {}, sessionRows)])]));

    if (record.events.length) {
        rawDetails.appendChild(el('h4', { text: `Events (${record.events.length})` }));
        const eventColumns = ['event_sequence_id', 'timestamp_ms', 'phase_name', 'duration_ms', 'start_weight', 'end_weight',
            'motor_stop_target_weight', 'pulse_attempt_number', 'pulse_duration_ms', 'grind_latency_ms',
            'settling_duration_ms', 'pulse_flow_rate', 'loop_count', 'event_flags'];
        rawDetails.appendChild(buildRawTable(record.events, eventColumns));
    }

    if (record.measurements.length) {
        rawDetails.appendChild(el('h4', { text: `Measurements (${record.measurements.length})` }));
        const measurementColumns = ['sequence_id', 'timestamp_ms', 'weight_grams', 'weight_delta', 'flow_rate_g_per_s',
            'motor_is_on', 'phase_name', 'motor_stop_target_weight'];
        rawDetails.appendChild(buildRawTable(record.measurements, measurementColumns));
    }
    return rawDetails;
}

async function pullData() {
    if (!isWebBluetoothSupported()) {
        setStatus('Web Bluetooth is not supported in this browser. Use Chrome or Edge.', 'error');
        return;
    }

    const button = $('analyticsPullBtn');
    button.disabled = true;
    const client = new GrinderDataClient();
    let currentFileIndex = 0;
    let totalFiles = 0;

    client.onFileProgress = (percent) => {
        if (totalFiles > 0) {
            setProgressThrottled(((currentFileIndex + percent / 100) / totalFiles) * 100);
        }
    };

    try {
        setStatus('Scanning for grinder...');
        await client.connect();
        setStatus('Connected. Requesting session list...');

        const { records: pulled, errors } = await client.pullAllSessions((progress) => {
            if (progress.stage === 'list-done') {
                totalFiles = progress.total;
                if (totalFiles === 0) setProgress(null);
            } else if (progress.stage === 'file') {
                currentFileIndex = progress.index;
                setProgress((progress.index / progress.total) * 100);
            }
            if (progress.message) setStatus(progress.message);
        });

        // Capture the device health snapshot over the same connection.
        const health = await client.captureDeviceHealth((progress) => {
            if (progress.message) setStatus(progress.message);
        });

        client.disconnect();
        setProgress(100);

        // Fold the fresh system info into the grinder card's cached snapshot.
        if (health?.system_info && window.GrinderSession) {
            window.GrinderSession.applySystemInfo(health.system_info);
        }

        if (pulled.length) {
            await saveSessions(pulled);
        }
        if (health) {
            await saveMeta('deviceReports', health);
        }
        if (pulled.length || health) {
            await saveMeta('lastPull', new Date().toISOString());
        }

        if (errors.length) {
            setStatus(`Pulled ${pulled.length} sessions; ${errors.length} failed: `
                + errors.map((e) => `#${e.sessionId} (${e.message})`).join(', '), 'warning');
        } else if (pulled.length) {
            setStatus(`Pulled ${pulled.length} sessions from the grinder.`, 'success');
        } else {
            setStatus('The grinder has no stored sessions to pull.', 'warning');
        }

        await refreshFromStore();

        // Automatic cloud backup: idempotent push of anything the store is
        // missing, plus a best-effort health observation.
        const cloudConfig = getCloudConfig();
        if (cloudConfig?.uploadKey) {
            if (pulled.length) await backfillToCloud({ silent: true });
            if (health) {
                pushSnapshotToCloud(cloudConfig, health, activeDeviceId())
                    .catch((error) => console.log('Cloud snapshot push failed:', error.message));
            }
        }
    } catch (error) {
        client.disconnect();
        setStatus(`Pull failed: ${error.message}`, 'error');
        console.error('Analytics pull error:', error);
    } finally {
        setProgress(null);
        button.disabled = false;
    }
}

async function exportJson() {
    if (!records.length) {
        setStatus('Nothing to export yet — pull or import data first.', 'warning');
        return;
    }
    const deviceReports = await loadMeta('deviceReports');
    const json = buildExportJson(records, deviceReports);
    const stamp = new Date().toISOString().slice(0, 10);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = el('a', { href: url, download: `grind-analytics-${stamp}.json` });
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setStatus(`Exported ${records.length} sessions.`, 'success');
}

async function importJson(file) {
    try {
        const text = await file.text();
        const { records: imported, deviceReports } = parseImportJson(text);
        await saveSessions(imported);
        if (deviceReports) await saveMeta('deviceReports', deviceReports);
        await saveMeta('lastPull', new Date().toISOString());
        await refreshFromStore();
        setStatus(`Imported ${imported.length} sessions from ${file.name}.`, 'success');
    } catch (error) {
        setStatus(`Import failed: ${error.message}`, 'error');
    }
}

async function clearStoredData() {
    if (!window.confirm('Delete all grind data stored in this browser? This does not affect the grinder itself.')) {
        return;
    }
    await clearAll();
    selectedSessionId = null;
    await refreshFromStore();
    setStatus('Stored data cleared.', 'info');
}

// ---- cloud store (docs/CLOUD_SYNC.md) --------------------------------------
// Cloud sync fills the same IndexedDB as the BLE pull (records keyed by
// content hash), so every view renders identically from either source.

function activeDeviceId() {
    return window.GrinderSession?.getActive?.()?.snapshot?.system?.device_id || null;
}

async function syncFromCloud({ silent = false } = {}) {
    const config = getCloudConfig();
    if (!config) return;
    try {
        if (!silent) setStatus('Checking the cloud store...');
        const known = new Set(records.map((r) => r.sha256));
        const { records: fetched, errors, cloudTotal } = await pullFromCloud(config, known, (progress) => {
            setStatus(progress.message);
            if (progress.total) setProgressThrottled((progress.index / progress.total) * 100);
        });
        if (fetched.length) {
            await saveSessions(fetched);
            await saveMeta('lastPull', new Date().toISOString());
            await refreshFromStore();
        }
        if (errors.length) {
            setStatus(`Cloud sync: ${fetched.length} sessions added, ${errors.length} failed.`, 'warning');
        } else if (fetched.length) {
            setStatus(`Synced ${fetched.length} sessions from the cloud (${cloudTotal} in the store).`, 'success');
        } else if (!silent) {
            setStatus('Local data already matches the cloud store.', 'success');
        }
    } catch (error) {
        if (!silent) setStatus(`Cloud sync failed: ${error.message}`, 'error');
        console.error('Cloud sync error:', error);
    } finally {
        setProgress(null);
    }
}

// Push any locally-held sessions the store is missing (verbatim raw bytes;
// the server dedups by content hash, so this is always safe to re-run).
async function backfillToCloud({ silent = false } = {}) {
    const config = getCloudConfig();
    if (!config?.uploadKey) return;
    try {
        const { stored, errors } = await pushToCloud(config, records, activeDeviceId(), (progress) => {
            setStatus(progress.message);
            if (progress.total) setProgressThrottled((progress.index / progress.total) * 100);
        });
        if (errors.length) {
            setStatus(`Cloud backup: ${stored} sessions uploaded, ${errors.length} failed.`, 'warning');
        } else if (stored) {
            setStatus(`Backed up ${stored} sessions to the cloud.`, 'success');
        } else if (!silent) {
            setStatus('The cloud store already holds every local session.', 'success');
        }
    } catch (error) {
        if (!silent) setStatus(`Cloud backup failed: ${error.message}`, 'error');
        console.error('Cloud backfill error:', error);
    } finally {
        setProgress(null);
    }
}

async function setUpCloudStore() {
    try {
        const grinder = window.GrinderSession?.getActive?.();
        await createCloudStore(grinder?.label || null);
        renderCloudBar();
        setStatus('Cloud store created. Sessions you pull are now backed up automatically.', 'success');
        if (records.length) await backfillToCloud({ silent: true });
    } catch (error) {
        setStatus(`${error.message}. Cloud backup needs the hosted flasher (or your self-hosted server).`, 'error');
    }
}

async function disconnectCloudStore() {
    const config = getCloudConfig();
    if (!config) return;
    const warning = config.uploadKey
        ? 'Disconnect this browser from the cloud store? The store and its data stay on the server, '
            + 'but this browser holds the only upload key — without a provisioned grinder, copy the '
            + 'dashboard link first or the store becomes unreachable.'
        : 'Disconnect this browser from the cloud store? You can re-link with the dashboard link.';
    if (!window.confirm(warning)) return;
    clearCloudConfig();
    renderCloudBar();
    setStatus('Disconnected from the cloud store.', 'info');
}

async function deleteCloudStoreForever() {
    const config = getCloudConfig();
    if (!config?.uploadKey) return;
    if (!window.confirm('Permanently delete the cloud store and every session in it? '
        + 'Local data in this browser is kept.')) return;
    try {
        await deleteCloudStore(config);
        clearCloudConfig();
        renderCloudBar();
        setStatus('Cloud store deleted.', 'info');
    } catch (error) {
        setStatus(`Delete failed: ${error.message}`, 'error');
    }
}

function renderCloudBar() {
    const bar = $('analyticsCloudBar');
    if (!bar) return;
    bar.textContent = '';
    const config = getCloudConfig();

    if (!config) {
        const setup = el('button', { class: 'btn-ghost', text: 'Set up cloud backup' });
        setup.addEventListener('click', setUpCloudStore);
        bar.appendChild(setup);
        bar.appendChild(el('span', { class: 'store-line', text: 'Keep your full grind history beyond the grinder’s own storage.' }));
        return;
    }

    bar.appendChild(el('span', {
        class: 'store-line',
        text: `cloud store ${config.storeId}${config.uploadKey ? '' : ' · read-only link'}`,
    }));

    const sync = el('button', { class: 'btn-ghost', text: 'Sync from cloud' });
    sync.addEventListener('click', () => syncFromCloud());
    bar.appendChild(sync);

    if (config.uploadKey) {
        const push = el('button', { class: 'btn-ghost', text: 'Back up local sessions' });
        push.addEventListener('click', () => backfillToCloud());
        bar.appendChild(push);
    }

    const share = el('button', { class: 'btn-ghost', text: 'Copy dashboard link' });
    share.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(buildShareLink(config));
            setStatus('Dashboard link copied — anyone with it can view (not modify) this store.', 'success');
        } catch {
            setStatus(`Dashboard link: ${buildShareLink(config)}`, 'info');
        }
    });
    bar.appendChild(share);

    const disconnect = el('button', { class: 'btn-ghost', text: 'Disconnect' });
    disconnect.addEventListener('click', disconnectCloudStore);
    bar.appendChild(disconnect);

    if (config.uploadKey) {
        const destroy = el('button', { class: 'btn-ghost danger', text: 'Delete cloud store' });
        destroy.addEventListener('click', deleteCloudStoreForever);
        bar.appendChild(destroy);
    }
}

function init() {
    $('analyticsPullBtn').addEventListener('click', pullData);
    $('analyticsExportBtn').addEventListener('click', exportJson);
    $('analyticsClearBtn').addEventListener('click', clearStoredData);
    $('analyticsImportBtn').addEventListener('click', () => $('analyticsImportInput').click());
    $('analyticsImportInput').addEventListener('change', (event) => {
        const file = event.target.files[0];
        if (file) importJson(file);
        event.target.value = '';
    });

    if (!isWebBluetoothSupported()) {
        setStatus('Web Bluetooth is unavailable in this browser — pulling from the grinder is disabled, but you can still import a JSON export.', 'warning');
        $('analyticsPullBtn').disabled = true;
    }

    // Re-render the summary when the grinder card's background snapshot
    // arrives (device session count, logging state) — and claim the device's
    // cloud store by possession: a grinder this browser can read hands out
    // its read-only dashboard keys (docs/CLOUD_SYNC.md "Auth model").
    window.GrinderSession?.onChange?.((type) => {
        if (type !== 'snapshot') return;
        const cloud = window.GrinderSession?.getActive?.()?.snapshot?.cloud;
        if (cloud?.configured && cloud.view_key && !getCloudConfig()) {
            saveCloudConfig({
                storeId: cloud.store_id,
                viewKey: cloud.view_key,
                baseUrl: cloud.server_url || '',
                linkedAt: Date.now(),
            });
            renderCloudBar();
            syncFromCloud({ silent: true });
        }
        renderSummary();
    });

    // A shared dashboard link (#store=...) links this browser to a cloud
    // store before anything renders.
    const adopted = adoptShareFragment();
    renderCloudBar();

    // Returning users with stored data are almost always here for the data:
    // land on Analytics. First-time visitors keep the flasher as the default.
    // A cloud-linked browser refreshes from the store in the background —
    // no grinder needed.
    refreshFromStore().then(async () => {
        if ((records.length || getCloudConfig()) && typeof window.showTab === 'function') {
            window.showTab('analytics');
        }
        if (getCloudConfig()) {
            await syncFromCloud({ silent: !adopted });
        }
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
