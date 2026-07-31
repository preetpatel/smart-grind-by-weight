// Analytics tab controller: pull data over BLE, persist it, and render the
// session browser. Chart views arrive in later milestones and will hang off
// the same stored records.

import { GrinderDataClient, isWebBluetoothSupported } from './ble-data.js';
import { MODE_MAP, PROFILE_MAP, TERMINATION_REASON_MAP } from './parser.js';
import {
    saveSessions, loadSessions, clearAll, saveMeta, loadMeta,
    buildExportJson, parseImportJson,
} from './store.js';
import {
    buildOverviewFigure, filterForDisplay, grindTimeSeconds,
    DEFAULT_HIDDEN_PHASES, PHASE_DESCRIPTIONS,
} from './charts.js';

const TOLERANCE_G = 0.03; // grind accuracy tolerance, as in the Streamlit report
const PLOTLY_CDN = 'https://cdn.plot.ly/plotly-2.35.2.min.js';

let records = [];
let selectedSessionId = null;

// Chart view options, shared across sessions like the Streamlit sidebar state.
const viewOptions = {
    includeTaring: false,
    smoothingMs: 500,
    hiddenPhases: new Set(DEFAULT_HIDDEN_PHASES),
};

let plotlyPromise = null;
function loadPlotly() {
    if (window.Plotly) return Promise.resolve(window.Plotly);
    if (!plotlyPromise) {
        plotlyPromise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = PLOTLY_CDN;
            script.onload = () => resolve(window.Plotly);
            script.onerror = () => reject(new Error('Failed to load the Plotly chart library (offline?)'));
            document.head.appendChild(script);
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
    renderSummary();
    renderSessionsTable();
    renderDetail();
}

async function renderSummary() {
    const summary = $('analyticsSummary');
    summary.textContent = '';
    if (!records.length) {
        summary.appendChild(el('div', {
            class: 'status info',
            text: 'No grind data stored yet. Pull data from the grinder or import a JSON export.',
        }));
        return;
    }
    const lastPull = await loadMeta('lastPull');
    const totalEvents = records.reduce((sum, r) => sum + r.events.length, 0);
    const totalMeasurements = records.reduce((sum, r) => sum + r.measurements.length, 0);
    summary.appendChild(el('div', {
        class: 'status success',
        text: `${records.length} sessions stored (${totalEvents} events, ${totalMeasurements} measurements)`
            + (lastPull ? ` — last updated ${new Date(lastPull).toLocaleString()}` : ''),
    }));
}

function renderSessionsTable() {
    const container = $('analyticsSessionsContainer');
    container.textContent = '';
    if (!records.length) return;

    const headers = ['ID', 'Started (uptime)', 'Mode', 'Profile', 'Target', 'Final (g)', 'Error', 'Pulses', 'Result', 'Events', 'Samples'];
    const thead = el('thead', {}, [el('tr', {}, headers.map((h) => el('th', { text: h })))]);

    const rows = records.map((record) => {
        const s = record.session;
        const row = el('tr', { class: s.session_id === selectedSessionId ? 'selected' : '' }, [
            el('td', { text: `#${s.session_id}` }),
            el('td', { text: formatUptime(s.session_timestamp) }),
            el('td', { text: MODE_MAP[s.grind_mode] ?? 'UNKNOWN' }),
            el('td', { text: PROFILE_MAP[s.profile_id] ?? `P${s.profile_id}` }),
            el('td', { text: sessionTargetLabel(s) }),
            el('td', { text: s.final_weight.toFixed(2) }),
            el('td', { text: sessionErrorLabel(s) }),
            el('td', { text: String(s.pulse_count) }),
            el('td', { text: s.result_status }),
            el('td', { text: String(record.events.length) }),
            el('td', { text: String(record.measurements.length) }),
        ]);
        row.addEventListener('click', () => {
            selectedSessionId = s.session_id === selectedSessionId ? null : s.session_id;
            renderSessionsTable();
            renderDetail();
        });
        return row;
    });

    container.appendChild(el('h3', { text: 'Grind Sessions' }));
    container.appendChild(el('p', { class: 'table-hint', text: 'Click a session to inspect its raw events and measurements.' }));
    const wrapper = el('div', { class: 'table-scroll' }, [el('table', { class: 'data-table' }, [thead, el('tbody', {}, rows)])]);
    container.appendChild(wrapper);
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

function buildChartControls(record, onChange) {
    const controls = el('div', { class: 'controls-row' });

    // Include-taring toggle
    const taringLabel = el('label', { class: 'control' });
    const taringBox = el('input', { type: 'checkbox' });
    taringBox.checked = viewOptions.includeTaring;
    taringBox.addEventListener('change', () => {
        viewOptions.includeTaring = taringBox.checked;
        onChange(true); // phase list may change
    });
    taringLabel.appendChild(taringBox);
    taringLabel.appendChild(document.createTextNode(' Include taring'));
    controls.appendChild(taringLabel);

    // Flow smoothing selector
    const smoothingLabel = el('label', { class: 'control', text: 'Flow smoothing ' });
    const smoothingSelect = el('select', {});
    for (const [label, value] of [['None', 0], ['100 ms', 100], ['500 ms', 500], ['1000 ms', 1000], ['1500 ms', 1500]]) {
        const option = el('option', { value: String(value), text: label });
        if (value === viewOptions.smoothingMs) option.selected = true;
        smoothingSelect.appendChild(option);
    }
    smoothingSelect.addEventListener('change', () => {
        viewOptions.smoothingMs = Number(smoothingSelect.value);
        onChange(false);
    });
    smoothingLabel.appendChild(smoothingSelect);
    controls.appendChild(smoothingLabel);

    // Per-phase event marker toggles
    const phases = [...new Set(filterForDisplay(record.events, viewOptions.includeTaring).map((e) => e.phase_name))].sort();
    for (const phase of phases) {
        const label = el('label', { class: 'control', title: PHASE_DESCRIPTIONS[phase] || phase });
        const box = el('input', { type: 'checkbox' });
        box.checked = !viewOptions.hiddenPhases.has(phase);
        box.addEventListener('change', () => {
            if (box.checked) viewOptions.hiddenPhases.delete(phase);
            else viewOptions.hiddenPhases.add(phase);
            onChange(false);
        });
        label.appendChild(box);
        label.appendChild(document.createTextNode(` ${phase}`));
        controls.appendChild(label);
    }

    return controls;
}

async function renderChart(record) {
    const chartDiv = $('analyticsChart');
    if (!chartDiv) return;
    try {
        const Plotly = await loadPlotly();
        const phases = [...new Set(filterForDisplay(record.events, viewOptions.includeTaring).map((e) => e.phase_name))];
        const visiblePhases = phases.filter((p) => !viewOptions.hiddenPhases.has(p));
        const { traces, layout, config } = buildOverviewFigure(record, {
            includeTaring: viewOptions.includeTaring,
            smoothingMs: viewOptions.smoothingMs,
            visiblePhases,
        });
        await Plotly.react(chartDiv, traces, layout, config);
    } catch (error) {
        chartDiv.textContent = `Chart unavailable: ${error.message}`;
        console.error('Chart render error:', error);
    }
}

function renderDetail() {
    const container = $('analyticsDetailContainer');
    container.textContent = '';
    if (selectedSessionId === null) return;
    const record = records.find((r) => r.session_id === selectedSessionId);
    if (!record) return;

    const rerender = (controlsChanged) => {
        if (controlsChanged) renderDetail();
        else renderChart(record);
    };

    container.appendChild(el('h3', { text: `Session #${record.session_id} — Overall Analysis` }));
    container.appendChild(buildMetricsGrid(record));
    container.appendChild(buildChartControls(record, rerender));
    container.appendChild(el('div', { id: 'analyticsChart', class: 'chart-container' }));

    // Raw data lives in a collapsed section below the analysis.
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
    container.appendChild(rawDetails);

    renderChart(record);
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

        client.disconnect();
        setProgress(100);

        if (pulled.length) {
            await saveSessions(pulled);
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

    refreshFromStore();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
