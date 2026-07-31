// Plotly figure builders for the analytics views. These port the chart logic
// from tools/streamlit-reports/grind_report.py so the web report reads the
// same as the local Streamlit one — including the weight + flow-rate overlay
// on a shared time axis, which is the established reading pattern for grind
// telemetry in this project.
//
// Colors are the report's established series colors, validated for CVD
// separation and surface contrast (dataviz palette checks pass on white).

import { rollingMeanByTime, interpolateAt, groupBy } from './frame.js';
import { MODE_MAP } from './parser.js';

export const COLOR_WEIGHT = '#4169E1'; // royalblue
export const COLOR_FLOW = '#006400'; // darkgreen
export const COLOR_TARGET = '#FA8072'; // salmon reference line
export const COLOR_MOTOR_FILL = 'rgba(72, 61, 139, 0.3)'; // DarkSlateBlue, motor-on band
export const COLOR_EVENT = '#808080';
export const COLOR_DETECTION = '#800080';

// Phases stripped from every chart (internal controller states).
const INTERNAL_PHASES = ['IDLE', 'SETUP'];
const TARE_PHASES = ['TARING', 'TARE_CONFIRM'];
// Phases whose event markers default to hidden, as in the Streamlit sidebar.
export const DEFAULT_HIDDEN_PHASES = ['PULSE_DECISION', 'PULSE_SETTLING', 'PURGE_CONFIRM'];

export const PHASE_DESCRIPTIONS = {
    TARING: 'Zeroing scale before grind',
    TARE_CONFIRM: 'Confirming tare completion',
    PRIME: 'Priming grind to refill chute',
    PRIME_SETTLING: 'Settling after priming grind',
    PURGE_CONFIRM: 'Waiting for purge confirmation',
    PREDICTIVE: 'Main grinding with flow prediction',
    PULSE_DECISION: 'Deciding if correction needed',
    PULSE_EXECUTE: 'Executing precision pulse',
    PULSE_SETTLING: 'Waiting for weight to settle',
    FINAL_SETTLING: 'Final weight stabilization',
};

export function filterForDisplay(items, includeTaring) {
    const excluded = includeTaring ? INTERNAL_PHASES : INTERNAL_PHASES.concat(TARE_PHASES);
    return items.filter((item) => !excluded.includes(item.phase_name));
}

// Contiguous motor-on periods as background shapes, ported from
// add_motor_on_rects: blocks split where the gap exceeds 3x the median
// sampling interval.
export function motorOnShapes(measurements) {
    const on = measurements.filter((m) => m.motor_is_on === 1).sort((a, b) => a.timestamp_ms - b.timestamp_ms);
    if (!on.length) return [];

    const gaps = [];
    for (let i = 1; i < on.length; i++) gaps.push(on[i].timestamp_ms - on[i - 1].timestamp_ms);
    const sorted = [...gaps].sort((a, b) => a - b);
    let median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 50;
    if (!median) median = 50;

    const shapes = [];
    let blockStart = on[0].timestamp_ms;
    let prev = on[0].timestamp_ms;
    for (let i = 1; i <= on.length; i++) {
        const t = i < on.length ? on[i].timestamp_ms : null;
        if (t === null || t - prev > 3 * median) {
            shapes.push({
                type: 'rect', xref: 'x', yref: 'paper',
                x0: blockStart, x1: prev + median, y0: 0, y1: 1,
                fillcolor: COLOR_MOTOR_FILL, opacity: 1, layer: 'below', line: { width: 0 },
            });
            blockStart = t;
        }
        prev = t;
    }
    return shapes;
}

// Staggered marker heights so adjacent event labels don't collide, ported
// from get_staggered_y_positions.
function staggeredPositions(events, yMax) {
    if (!Number.isFinite(yMax)) yMax = 10;
    const levels = [yMax * 1.05, yMax * 1.20, yMax * 1.12, yMax * 1.27];
    const span = events.length ? events[events.length - 1].timestamp_ms - events[0].timestamp_ms : 0;
    const threshold = events.length ? span / 15 : 1000;
    const positions = [];
    let lastX = -Infinity;
    let level = 0;
    for (const event of events) {
        level = (event.timestamp_ms - lastX) < threshold ? (level + 1) % levels.length : 0;
        positions.push(levels[level]);
        lastX = event.timestamp_ms;
    }
    return positions;
}

// Phase-specific hover rows, ported from get_phase_specific_hover_data.
function phaseHover(phase, events) {
    const base = (e) => [e.phase_name, e.duration_ms, e.start_weight, e.end_weight];
    const yieldOf = (e) => e.end_weight - e.start_weight;

    switch (phase) {
        case 'PRIME':
            return {
                template: '<b>%{customdata[0]}</b><br>Duration: %{customdata[1]} ms<br>'
                    + 'Primed Weight: %{customdata[4]:.3f}g<br>'
                    + 'Start: %{customdata[2]:.3f}g → End: %{customdata[3]:.3f}g<extra></extra>',
                customdata: events.map((e) => [...base(e), yieldOf(e)]),
            };
        case 'PREDICTIVE':
            return {
                template: '<b>%{customdata[0]}</b><br>Duration: %{customdata[1]} ms<br>'
                    + 'Yield: %{customdata[4]:.2f}g<br>'
                    + 'Start: %{customdata[2]:.3f}g → End: %{customdata[3]:.2f}g<br>'
                    + 'Motor Stop Target: %{customdata[5]:.2f}g<br>'
                    + 'Grind Latency: %{customdata[6]} ms<extra></extra>',
                customdata: events.map((e) => [...base(e), yieldOf(e), e.motor_stop_target_weight, e.grind_latency_ms]),
            };
        case 'PULSE_DECISION':
            return {
                template: '<b>%{customdata[0]}</b><br>Duration: %{customdata[1]} ms<br>'
                    + 'Decision Point<br>Weight: %{customdata[2]:.3f}g → %{customdata[3]:.3f}g<extra></extra>',
                customdata: events.map(base),
            };
        case 'PULSE_EXECUTE':
            return {
                template: '<b>%{customdata[0]} #%{customdata[4]}</b><br>'
                    + 'Pulse Duration: %{customdata[5]} ms<br>Phase Duration: %{customdata[1]} ms<br>'
                    + 'Weight: %{customdata[2]:.3f}g → %{customdata[3]:.3f}g<extra></extra>',
                customdata: events.map((e) => [...base(e), e.pulse_attempt_number, e.pulse_duration_ms]),
            };
        case 'PULSE_SETTLING':
        case 'PRIME_SETTLING': {
            const gainLabel = phase === 'PRIME_SETTLING' ? 'Residual Gain' : 'Yield';
            return {
                template: '<b>%{customdata[0]}</b><br>Settling Duration: %{customdata[5]} ms<br>'
                    + `Phase Duration: %{customdata[1]} ms<br>${gainLabel}: %{customdata[4]:.3f}g<br>`
                    + 'Start: %{customdata[2]:.3f}g → End: %{customdata[3]:.3f}g<extra></extra>',
                customdata: events.map((e) => [...base(e), yieldOf(e), e.settling_duration_ms]),
            };
        }
        case 'PURGE_CONFIRM':
            return {
                template: '<b>%{customdata[0]}</b><br>Duration: %{customdata[1]} ms<br>'
                    + 'Awaiting purge confirmation<br>'
                    + 'Start: %{customdata[2]:.3f}g → End: %{customdata[3]:.3f}g<extra></extra>',
                customdata: events.map(base),
            };
        case 'FINAL_SETTLING':
            return {
                template: '<b>%{customdata[0]}</b><br>Duration: %{customdata[1]} ms<br>'
                    + 'Final Yield: %{customdata[4]:.3f}g<br>'
                    + 'Start: %{customdata[2]:.3f}g → End: %{customdata[3]:.3f}g<extra></extra>',
                customdata: events.map((e) => [...base(e), yieldOf(e)]),
            };
        default:
            return {
                template: '<b>%{customdata[0]}</b><br>Duration: %{customdata[1]} ms<br>'
                    + 'Start: %{customdata[2]:.3f}g<br>End: %{customdata[3]:.3f}g<extra></extra>',
                customdata: events.map(base),
            };
    }
}

// Marker traces + dotted guide lines + angled labels for the displayed events.
export function eventMarkerLayers(events, measurements) {
    if (!events.length) return { traces: [], shapes: [], annotations: [] };

    const sorted = [...events].sort((a, b) => a.timestamp_ms - b.timestamp_ms);
    const yMax = measurements.length ? Math.max(...measurements.map((m) => m.weight_grams)) : 10;
    const positions = staggeredPositions(sorted, yMax);
    const byIndex = new Map(sorted.map((e, i) => [e, positions[i]]));

    const shapes = sorted.map((e) => ({
        type: 'line', xref: 'x', yref: 'paper',
        x0: e.timestamp_ms, x1: e.timestamp_ms, y0: 0, y1: 1,
        line: { color: COLOR_EVENT, width: 1, dash: 'dot' }, opacity: 0.5, layer: 'below',
    }));

    const annotations = sorted.map((e) => ({
        x: e.timestamp_ms, y: byIndex.get(e), text: e.phase_name,
        showarrow: false, textangle: -45, yanchor: 'bottom', yshift: 5,
        font: { size: 10, color: COLOR_EVENT },
    }));

    const traces = [];
    for (const [phase, group] of groupBy(sorted, (e) => e.phase_name)) {
        const { template, customdata } = phaseHover(phase, group);
        traces.push({
            x: group.map((e) => e.timestamp_ms),
            y: group.map((e) => byIndex.get(e)),
            mode: 'markers',
            marker: { symbol: 'triangle-down', color: COLOR_EVENT, size: 10 },
            customdata,
            hovertemplate: template,
            name: phase,
            showlegend: false,
            yaxis: 'y',
        });
    }
    return { traces, shapes, annotations };
}

// The main session chart: weight + flow rate over time with motor-on bands,
// event markers, the target line, and the flow-detection marker.
export function buildOverviewFigure(record, options) {
    const { includeTaring = false, smoothingMs = 500, visiblePhases = null } = options;
    const session = record.session;
    const mode = MODE_MAP[session.grind_mode] ?? 'WEIGHT';

    const measurements = filterForDisplay(record.measurements, includeTaring)
        .slice()
        .sort((a, b) => a.timestamp_ms - b.timestamp_ms);
    const events = filterForDisplay(record.events, includeTaring);

    const timestamps = measurements.map((m) => m.timestamp_ms);
    const weights = measurements.map((m) => m.weight_grams);
    const rawFlow = measurements.map((m) => m.flow_rate_g_per_s);
    const flow = smoothingMs ? rollingMeanByTime(timestamps, rawFlow, smoothingMs) : rawFlow;
    const flowLabel = smoothingMs ? `Flow Rate (${smoothingMs} ms)` : 'Flow Rate';

    const traces = [
        {
            x: timestamps, y: weights, mode: 'lines', name: 'Weight',
            line: { color: COLOR_WEIGHT, width: 2 },
            hovertemplate: 'Weight: %{y:.3f}g<extra></extra>',
        },
        {
            x: timestamps, y: flow, mode: 'lines', name: flowLabel,
            line: { color: COLOR_FLOW, width: 1.5 }, yaxis: 'y2',
            hovertemplate: 'Flow: %{y:.2f}g/s<extra></extra>',
        },
    ];

    const shapes = motorOnShapes(record.measurements);
    const annotations = [];

    if (mode === 'WEIGHT') {
        shapes.push({
            type: 'line', xref: 'paper', yref: 'y',
            x0: 0, x1: 1, y0: session.target_weight, y1: session.target_weight,
            line: { color: COLOR_TARGET, width: 1.5, dash: 'dash' },
        });
        annotations.push({
            xref: 'paper', yref: 'y', x: 0.99, y: session.target_weight,
            text: 'Target (g)', showarrow: false, yanchor: 'top',
            font: { size: 11, color: COLOR_TARGET },
        });
    }

    const displayedEvents = visiblePhases
        ? events.filter((e) => visiblePhases.includes(e.phase_name))
        : events;
    const markers = eventMarkerLayers(displayedEvents, measurements);
    traces.push(...markers.traces);
    shapes.push(...markers.shapes);
    annotations.push(...markers.annotations);

    // Start-of-flow-detection marker (weight mode): predictive start + latency.
    const predictive = events.find((e) => e.phase_name === 'PREDICTIVE');
    if (mode === 'WEIGHT' && predictive && timestamps.length) {
        const detectionTime = predictive.timestamp_ms + predictive.grind_latency_ms;
        traces.push({
            x: [detectionTime],
            y: [interpolateAt(detectionTime, timestamps, flow)],
            mode: 'markers',
            marker: { symbol: 'x-thin-open', color: COLOR_DETECTION, size: 10, line: { width: 2 } },
            name: 'Start of flow detected',
            yaxis: 'y2',
            hovertemplate: '<b>Start of flow detected</b><br>Time: %{x} ms<br>Flow Rate: %{y:.2f} g/s<extra></extra>',
        });
    }

    const layout = {
        title: { text: `Grind Profile for Session #${session.session_id}`, font: { size: 16 } },
        xaxis: { title: { text: 'Time (milliseconds)' }, gridcolor: '#eef0f3', zeroline: false },
        yaxis: { title: { text: 'Weight (g)' }, gridcolor: '#eef0f3', zeroline: false },
        yaxis2: { title: { text: 'Flow Rate (g/s)' }, overlaying: 'y', side: 'right', showgrid: false, zeroline: false },
        hovermode: 'x unified',
        legend: { yanchor: 'top', y: 0.99, xanchor: 'left', x: 0.01, bgcolor: 'rgba(255,255,255,0.7)' },
        shapes,
        annotations,
        paper_bgcolor: '#ffffff',
        plot_bgcolor: '#ffffff',
        margin: { t: 50, r: 60, b: 50, l: 60 },
    };

    return { traces, layout, config: { responsive: true, displaylogo: false } };
}

// Total active grind time in seconds: predictive start to the end of the last
// settling phase, as in the Streamlit summary.
export function grindTimeSeconds(events) {
    const predictive = events.filter((e) => e.phase_name === 'PREDICTIVE');
    if (!predictive.length) return 0;
    const start = Math.min(...predictive.map((e) => e.timestamp_ms));
    const settles = events.filter((e) => ['FINAL_SETTLING', 'PULSE_SETTLING', 'PRIME_SETTLING'].includes(e.phase_name));
    if (!settles.length) return 0;
    const end = Math.max(...settles.map((e) => e.timestamp_ms + e.duration_ms));
    return (end - start) / 1000;
}
