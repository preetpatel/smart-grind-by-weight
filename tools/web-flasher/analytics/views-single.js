// Single-session analysis tabs beyond the overview: Predictive Phase, Pulse
// Phase, and Controller Performance — ports of the matching Streamlit tabs.

import { MODE_MAP } from './parser.js';
import { rollingMeanByTime, interpolateAt, resampleLast } from './frame.js';
import {
    buildPhaseFigure, filterForDisplay,
    COLOR_WEIGHT, COLOR_DETECTION,
} from './charts.js';
import { percentile95Series } from './percentile.js';

const COLOR_MOTOR_STOP_TARGET = '#CC8800'; // orange reference line
const COLOR_PERCENTILE = '#800080'; // purple, matches the detection marker family
const COLOR_REFERENCE_LINE = '#808080';

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

function metricTile(label, value, delta = null, deltaClass = '') {
    const children = [
        el('div', { class: 'metric-label', text: label }),
        el('div', { class: 'metric-value', text: value }),
    ];
    if (delta !== null) children.push(el('div', { class: `metric-delta ${deltaClass}`, text: delta }));
    return el('div', { class: 'metric' }, children);
}

function infoBox(text) {
    return el('div', { class: 'status info', text });
}

function smoothedFlow(measurements, smoothingMs) {
    const raw = measurements.map((m) => m.flow_rate_g_per_s);
    if (!smoothingMs) return raw;
    return rollingMeanByTime(measurements.map((m) => m.timestamp_ms), raw, smoothingMs);
}

function chartDiv(container, cls = 'chart-container') {
    const div = el('div', { class: cls });
    container.appendChild(div);
    return div;
}

// --- Predictive Phase tab -------------------------------------------------

export function renderPredictiveTab(container, record, viewOptions, plot) {
    if ((MODE_MAP[record.session.grind_mode] ?? 'WEIGHT') !== 'WEIGHT') {
        container.appendChild(infoBox('Predictive analysis is only available for grind-by-weight sessions.'));
        return;
    }
    const events = filterForDisplay(record.events, viewOptions.includeTaring);
    const predictiveEvents = events.filter((e) => e.phase_name === 'PREDICTIVE');
    if (!predictiveEvents.length) {
        container.appendChild(infoBox('No predictive phase data found for this session.'));
        return;
    }

    const session = record.session;
    const predictive = predictiveEvents[0];
    const measurements = filterForDisplay(record.measurements, viewOptions.includeTaring)
        .slice().sort((a, b) => a.timestamp_ms - b.timestamp_ms);

    let phaseMeasurements = measurements.filter((m) => m.phase_name === 'PREDICTIVE');
    const eventsToMark = [predictive];

    // Include the first settling phase after the predictive phase so coasting
    // is visible, as in the Streamlit tab.
    const predictiveEnd = predictive.timestamp_ms + predictive.duration_ms;
    const firstSettle = events
        .filter((e) => e.phase_name === 'PULSE_SETTLING' && e.timestamp_ms >= predictiveEnd)
        .sort((a, b) => a.timestamp_ms - b.timestamp_ms)[0] || null;
    if (firstSettle) {
        const settleEnd = firstSettle.timestamp_ms + firstSettle.duration_ms;
        const settleMeasurements = measurements.filter(
            (m) => m.timestamp_ms >= firstSettle.timestamp_ms && m.timestamp_ms <= settleEnd);
        const seen = new Set(phaseMeasurements.map((m) => m.timestamp_ms));
        phaseMeasurements = phaseMeasurements
            .concat(settleMeasurements.filter((m) => !seen.has(m.timestamp_ms)))
            .sort((a, b) => a.timestamp_ms - b.timestamp_ms);
        eventsToMark.push(firstSettle);
    }

    // Metrics
    const motorStopOffset = predictive.motor_stop_target_weight;
    const motorStopTarget = session.target_weight - motorStopOffset;
    const yieldValue = firstSettle
        ? firstSettle.end_weight - predictive.start_weight
        : predictive.end_weight - predictive.start_weight;

    container.appendChild(el('div', { class: 'metric-grid' }, [
        metricTile('Total Yield (g)', yieldValue.toFixed(2)),
        metricTile('Motor Stop Target', `${motorStopTarget.toFixed(2)} g`, `Stop Offset: ${motorStopOffset.toFixed(2)}g`),
        metricTile('Latency-to-Coast Ratio', session.latency_to_coast_ratio.toFixed(2)),
        metricTile('Grind Latency (ms)', String(predictive.grind_latency_ms)),
    ]));

    if (!phaseMeasurements.length) {
        container.appendChild(infoBox('No measurement data recorded for the predictive phase.'));
        return;
    }

    const flow = smoothedFlow(phaseMeasurements, viewOptions.smoothingMs);
    const timestamps = phaseMeasurements.map((m) => m.timestamp_ms);

    const extraTraces = [];

    // 95th percentile flow rate over 100ms-resampled data (2.5s window,
    // 300ms sub-window, 100ms step), as computed by the firmware.
    const resampled = resampleLast(phaseMeasurements, 100);
    const percentile = percentile95Series(resampled, { windowMs: 2500, subWindowMs: 300, stepMs: 100 });
    if (percentile.some((p) => p.flow_rate_95p !== 0)) {
        extraTraces.push({
            x: percentile.map((p) => p.timestamp_ms),
            y: percentile.map((p) => p.flow_rate_95p),
            mode: 'lines', name: '95th Pct. Flow Rate (2.5s/300ms/100ms)',
            line: { color: COLOR_PERCENTILE, width: 2, dash: 'dot' }, yaxis: 'y2',
            hovertemplate: '95th pct: %{y:.2f}g/s<extra></extra>',
        });
    }

    // Start-of-flow-detection marker
    const detectionTime = predictive.timestamp_ms + predictive.grind_latency_ms;
    extraTraces.push({
        x: [detectionTime],
        y: [interpolateAt(detectionTime, timestamps, flow)],
        mode: 'markers',
        marker: { symbol: 'x-thin-open', color: COLOR_DETECTION, size: 10, line: { width: 2 } },
        name: 'Start of flow detected', yaxis: 'y2',
        hovertemplate: '<b>Start of flow detected</b><br>Time: %{x} ms<br>Flow Rate: %{y:.2f} g/s<extra></extra>',
    });

    const figure = buildPhaseFigure({
        title: 'Predictive Phase & First Settle Details',
        measurements: phaseMeasurements,
        flowValues: flow,
        fullMeasurements: record.measurements,
        events: eventsToMark,
        extraTraces,
        hlines: [{ y: motorStopTarget, color: COLOR_MOTOR_STOP_TARGET, text: 'Motor Stop Target' }],
    });
    plot(chartDiv(container), figure);
}

// --- Pulse Phase tab ------------------------------------------------------

function pulseSummary(events) {
    const pulseExecutes = events.filter((e) => e.phase_name === 'PULSE_EXECUTE')
        .sort((a, b) => a.timestamp_ms - b.timestamp_ms);
    const settles = events.filter((e) => e.phase_name === 'PULSE_SETTLING');
    const predictive = events.find((e) => e.phase_name === 'PREDICTIVE');
    const pulseFlowRate = predictive ? predictive.pulse_flow_rate : 0;

    const rows = pulseExecutes.map((pulse) => {
        const settle = settles
            .filter((s) => s.timestamp_ms > pulse.timestamp_ms)
            .sort((a, b) => a.timestamp_ms - b.timestamp_ms)[0] || null;
        const endWeight = settle ? settle.end_weight : pulse.end_weight;
        return {
            label: `Pulse ${pulse.pulse_attempt_number}`,
            durationMs: pulse.pulse_duration_ms,
            startWeight: pulse.start_weight,
            endWeight,
            yield: endWeight - pulse.start_weight,
            expectedYield: (pulse.pulse_duration_ms / 1000) * pulseFlowRate,
            settlingMs: settle ? settle.duration_ms : 0,
        };
    });
    return { rows, pulseFlowRate };
}

export function renderPulseTab(container, record, viewOptions, plot) {
    if ((MODE_MAP[record.session.grind_mode] ?? 'WEIGHT') !== 'WEIGHT') {
        container.appendChild(infoBox('Pulse analysis is only available for grind-by-weight sessions.'));
        return;
    }
    const events = filterForDisplay(record.events, viewOptions.includeTaring);
    const { rows, pulseFlowRate } = pulseSummary(events);
    if (!rows.length) {
        container.appendChild(infoBox('No pulse phase data found for this session.'));
        return;
    }

    const totalYield = rows.reduce((sum, r) => sum + r.yield, 0);
    container.appendChild(el('div', { class: 'metric-grid' }, [
        metricTile('Total Pulse Yield (g)', totalYield.toFixed(2)),
        metricTile('Number of Pulses', String(rows.length)),
        metricTile('Pulse Flow Rate (g/s)', pulseFlowRate.toFixed(3)),
    ]));

    // Summary table
    container.appendChild(el('h4', { text: 'Pulse Summary' }));
    const headers = ['Pulse #', 'Duration (ms)', 'Start Weight (g)', 'End Weight (g)', 'Pulse Yield (g)', 'Expected Yield (g)', 'Settling Time (ms)'];
    const thead = el('thead', {}, [el('tr', {}, headers.map((h) => el('th', { text: h })))]);
    const tbody = el('tbody', {}, rows.map((r) => el('tr', {}, [
        el('td', { text: r.label }),
        el('td', { text: r.durationMs.toFixed(0) }),
        el('td', { text: r.startWeight.toFixed(3) }),
        el('td', { text: r.endWeight.toFixed(3) }),
        el('td', { text: r.yield.toFixed(3) }),
        el('td', { text: r.expectedYield.toFixed(3) }),
        el('td', { text: String(r.settlingMs) }),
    ])));
    container.appendChild(el('div', { class: 'table-scroll' }, [el('table', { class: 'data-table' }, [thead, tbody])]));

    // Three small charts: contribution, effectiveness, prediction accuracy
    const chartRow = el('div', { class: 'chart-row' });
    container.appendChild(chartRow);
    const layoutBase = (title, xTitle, yTitle) => ({
        title: { text: title, font: { size: 14 } },
        xaxis: { title: { text: xTitle }, gridcolor: '#eef0f3', zeroline: false },
        yaxis: { title: { text: yTitle }, gridcolor: '#eef0f3', zeroline: false },
        paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff',
        margin: { t: 40, r: 20, b: 45, l: 55 },
        showlegend: false,
    });
    const config = { responsive: true, displaylogo: false };

    plot(chartDiv(chartRow, 'chart-container small'), {
        traces: [{
            type: 'bar',
            x: rows.map((r) => r.label), y: rows.map((r) => r.yield),
            text: rows.map((r) => `${r.yield.toFixed(2)}g`), textposition: 'auto',
            marker: { color: COLOR_WEIGHT },
            hovertemplate: '%{x}: %{y:.3f}g<extra></extra>',
        }],
        layout: layoutBase('Pulse Contribution', 'Pulse', 'Pulse Yield (g)'),
        config,
    });

    plot(chartDiv(chartRow, 'chart-container small'), {
        traces: [{
            x: rows.map((r) => r.durationMs), y: rows.map((r) => r.yield),
            mode: 'markers', marker: { size: 10, color: COLOR_WEIGHT },
            text: rows.map((r) => r.label),
            hovertemplate: '%{text}<br>Duration: %{x} ms<br>Yield: %{y:.3f}g<extra></extra>',
        }],
        layout: layoutBase('Duration vs. Yield', 'Pulse Duration (ms)', 'Pulse Yield (g)'),
        config,
    });

    const accuracyValues = rows.flatMap((r) => [r.expectedYield, r.yield]);
    const accMin = Math.min(...accuracyValues);
    const accMax = Math.max(...accuracyValues);
    plot(chartDiv(chartRow, 'chart-container small'), {
        traces: [
            {
                x: rows.map((r) => r.expectedYield), y: rows.map((r) => r.yield),
                mode: 'markers', marker: { size: 10, color: COLOR_WEIGHT },
                text: rows.map((r) => r.label), name: 'Pulses',
                hovertemplate: '%{text}<br>Expected: %{x:.3f}g<br>Actual: %{y:.3f}g<extra></extra>',
            },
            {
                x: [accMin, accMax], y: [accMin, accMax], mode: 'lines',
                line: { dash: 'dash', color: COLOR_REFERENCE_LINE }, name: 'Perfect Prediction',
                hoverinfo: 'skip',
            },
        ],
        layout: layoutBase('Expected vs. Actual Yield', 'Expected Yield (g)', 'Actual Pulse Yield (g)'),
        config,
    });

    // Detail chart over the pulse-phase measurements
    const pulsePhases = ['PULSE_EXECUTE', 'PULSE_SETTLING', 'PULSE_DECISION'];
    const pulseMeasurements = filterForDisplay(record.measurements, viewOptions.includeTaring)
        .filter((m) => pulsePhases.includes(m.phase_name))
        .sort((a, b) => a.timestamp_ms - b.timestamp_ms);
    if (pulseMeasurements.length) {
        const figure = buildPhaseFigure({
            title: 'Pulse & Settling Details',
            measurements: pulseMeasurements,
            flowValues: smoothedFlow(pulseMeasurements, viewOptions.smoothingMs),
            fullMeasurements: record.measurements,
            events: events.filter((e) => pulsePhases.includes(e.phase_name)),
        });
        plot(chartDiv(container), figure);
    }
}

// --- Controller Performance tab -------------------------------------------

export function renderControllerTab(container, record, viewOptions) {
    container.appendChild(el('p', {
        class: 'table-hint',
        text: 'Controller loop performance per phase. The grind controller targets a 20 ms loop interval (50 Hz); '
            + 'lower frequencies indicate system load or blocking operations.',
    }));

    const events = filterForDisplay(record.events, viewOptions.includeTaring);
    if (!events.length) {
        container.appendChild(infoBox('No event data available for this session.'));
        return;
    }

    const headers = ['Phase Name', 'Duration (ms)', 'Loop Count', 'Frequency (Hz)', 'Avg ms/loop'];
    const thead = el('thead', {}, [el('tr', {}, headers.map((h) => el('th', { text: h })))]);
    const tbody = el('tbody', {}, events.map((e) => {
        const frequency = e.duration_ms > 0 ? e.loop_count / (e.duration_ms / 1000) : 0;
        const msPerLoop = e.loop_count > 0 ? e.duration_ms / e.loop_count : 0;
        return el('tr', {}, [
            el('td', { text: e.phase_name }),
            el('td', { text: String(e.duration_ms) }),
            el('td', { text: String(e.loop_count) }),
            el('td', { text: frequency.toFixed(1) }),
            el('td', { text: msPerLoop.toFixed(2) }),
        ]);
    }));
    container.appendChild(el('div', { class: 'table-scroll' }, [el('table', { class: 'data-table' }, [thead, tbody])]));
}
