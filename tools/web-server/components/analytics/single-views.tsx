'use client';

// Single-session analysis tabs beyond the overview: Predictive Phase, Pulse
// Phase, Vibration Analysis, and Controller Performance — React ports of the
// plain-JS views in tools/web-flasher/analytics/views-single.js.

import { useMemo, useState } from 'react';
import { MetricTile, Note } from '@/components/analytics/metric';
import { PlotlyChart } from '@/components/plotly-chart';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import type { Figure } from '@/lib/analytics/figures';
import {
    buildPhaseFigure,
    CHART_CONFIG,
    COLOR_DETECTION,
    COLOR_FLOW,
    COLOR_WEIGHT,
    chartLayout,
    filterForDisplay,
} from '@/lib/analytics/figures';
import { interpolateAt, resampleLast, rollingMeanByTime } from '@/lib/analytics/frame';
import { percentile95Series } from '@/lib/analytics/percentile';
import { amplitudeSpectrum, detrendLinear, iirnotch, lfilter } from '@/lib/analytics/signal';
import type { StoredRecord } from '@/lib/analytics/types';
import type { ParsedGrindEvent, ParsedGrindMeasurement } from '@/lib/parser';
import { MODE_MAP } from '@/lib/parser';

const COLOR_IIR = '#d95926'; // orange — filtered-spectrum variant
const COLOR_NOTCH = COLOR_FLOW; // notch spectrum renders on its own chart

const COLOR_MOTOR_STOP_TARGET = '#d95926'; // orange reference line
const COLOR_PERCENTILE = COLOR_DETECTION; // detection marker family
const COLOR_REFERENCE_LINE = '#78716c'; // stone — chrome, not data

function smoothedFlow(measurements: ParsedGrindMeasurement[], smoothingMs: number): number[] {
    const raw = measurements.map((m) => m.flow_rate_g_per_s);
    if (!smoothingMs) return raw;
    return rollingMeanByTime(
        measurements.map((m) => m.timestamp_ms),
        raw,
        smoothingMs,
    );
}

function InfoBox({ text }: { text: string }) {
    return <Note>{text}</Note>;
}

// --- Predictive Phase tab -------------------------------------------------

interface PredictiveMetrics {
    yieldValue: number;
    motorStopTarget: number;
    motorStopOffset: number;
    latencyToCoastRatio: number;
    grindLatencyMs: number;
}

type PredictiveResult =
    | { kind: 'not-weight' }
    | { kind: 'no-events' }
    | { kind: 'no-measurements'; metrics: PredictiveMetrics }
    | { kind: 'ok'; metrics: PredictiveMetrics; figure: Figure };

function buildPredictive(
    record: StoredRecord,
    includeTaring: boolean,
    smoothingMs: number,
): PredictiveResult {
    if ((MODE_MAP[record.session.grind_mode] ?? 'WEIGHT') !== 'WEIGHT')
        return { kind: 'not-weight' };
    const events = filterForDisplay(record.events, includeTaring);
    const predictive = events.filter((e) => e.phase_name === 'PREDICTIVE')[0];
    if (!predictive) return { kind: 'no-events' };

    const session = record.session;
    const measurements = filterForDisplay(record.measurements, includeTaring)
        .slice()
        .sort((a, b) => a.timestamp_ms - b.timestamp_ms);

    let phaseMeasurements = measurements.filter((m) => m.phase_name === 'PREDICTIVE');
    const eventsToMark: ParsedGrindEvent[] = [predictive];

    // Include the first settling phase after the predictive phase so coasting
    // is visible, as in the Streamlit tab.
    const predictiveEnd = predictive.timestamp_ms + predictive.duration_ms;
    const firstSettle =
        events
            .filter((e) => e.phase_name === 'PULSE_SETTLING' && e.timestamp_ms >= predictiveEnd)
            .sort((a, b) => a.timestamp_ms - b.timestamp_ms)[0] ?? null;
    if (firstSettle) {
        const settleEnd = firstSettle.timestamp_ms + firstSettle.duration_ms;
        const settleMeasurements = measurements.filter(
            (m) => m.timestamp_ms >= firstSettle.timestamp_ms && m.timestamp_ms <= settleEnd,
        );
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

    const metrics: PredictiveMetrics = {
        yieldValue,
        motorStopTarget,
        motorStopOffset,
        latencyToCoastRatio: session.latency_to_coast_ratio,
        grindLatencyMs: predictive.grind_latency_ms,
    };

    if (!phaseMeasurements.length) return { kind: 'no-measurements', metrics };

    const flow = smoothedFlow(phaseMeasurements, smoothingMs);
    const timestamps = phaseMeasurements.map((m) => m.timestamp_ms);

    const extraTraces: Record<string, unknown>[] = [];

    // 95th percentile flow rate over 100ms-resampled data (2.5s window,
    // 300ms sub-window, 100ms step), as computed by the firmware.
    const resampled = resampleLast(phaseMeasurements, 100);
    const percentile = percentile95Series(resampled, {
        windowMs: 2500,
        subWindowMs: 300,
        stepMs: 100,
    });
    if (percentile.some((p) => p.flow_rate_95p !== 0)) {
        extraTraces.push({
            x: percentile.map((p) => p.timestamp_ms),
            y: percentile.map((p) => p.flow_rate_95p),
            mode: 'lines',
            name: '95th Pct. Flow Rate (2.5s/300ms/100ms)',
            line: { color: COLOR_PERCENTILE, width: 2, dash: 'dot' },
            yaxis: 'y2',
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
        name: 'Start of flow detected',
        yaxis: 'y2',
        hovertemplate:
            '<b>Start of flow detected</b><br>Time: %{x} ms<br>Flow Rate: %{y:.2f} g/s<extra></extra>',
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
    return { kind: 'ok', metrics, figure };
}

function PredictiveMetricGrid({ metrics }: { metrics: PredictiveMetrics }) {
    return (
        <div className="my-4 grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-3 lg:grid-cols-5">
            <MetricTile label="Total Yield (g)" value={metrics.yieldValue.toFixed(2)} />
            <MetricTile
                label="Motor Stop Target"
                value={`${metrics.motorStopTarget.toFixed(2)} g`}
                delta={`Stop Offset: ${metrics.motorStopOffset.toFixed(2)}g`}
            />
            <MetricTile
                label="Latency-to-Coast Ratio"
                value={metrics.latencyToCoastRatio.toFixed(2)}
            />
            <MetricTile label="Grind Latency (ms)" value={String(metrics.grindLatencyMs)} />
        </div>
    );
}

export function PredictiveTab({
    record,
    includeTaring,
    smoothingMs,
}: {
    record: StoredRecord;
    includeTaring: boolean;
    smoothingMs: number;
}) {
    const result = useMemo(
        () => buildPredictive(record, includeTaring, smoothingMs),
        [record, includeTaring, smoothingMs],
    );

    if (result.kind === 'not-weight') {
        return (
            <InfoBox text="Predictive analysis is only available for grind-by-weight sessions." />
        );
    }
    if (result.kind === 'no-events') {
        return <InfoBox text="No predictive phase data found for this session." />;
    }
    if (result.kind === 'no-measurements') {
        return (
            <>
                <PredictiveMetricGrid metrics={result.metrics} />
                <InfoBox text="No measurement data recorded for the predictive phase." />
            </>
        );
    }
    return (
        <>
            <PredictiveMetricGrid metrics={result.metrics} />
            <PlotlyChart figure={result.figure} />
        </>
    );
}

// --- Pulse Phase tab ------------------------------------------------------

interface PulseRow {
    label: string;
    durationMs: number;
    startWeight: number;
    endWeight: number;
    yieldG: number;
    expectedYield: number;
    settlingMs: number;
}

function pulseSummary(events: ParsedGrindEvent[]): { rows: PulseRow[]; pulseFlowRate: number } {
    const pulseExecutes = events
        .filter((e) => e.phase_name === 'PULSE_EXECUTE')
        .sort((a, b) => a.timestamp_ms - b.timestamp_ms);
    const settles = events.filter((e) => e.phase_name === 'PULSE_SETTLING');
    const predictive = events.find((e) => e.phase_name === 'PREDICTIVE');
    const pulseFlowRate = predictive ? predictive.pulse_flow_rate : 0;

    const rows = pulseExecutes.map((pulse): PulseRow => {
        const settle =
            settles
                .filter((s) => s.timestamp_ms > pulse.timestamp_ms)
                .sort((a, b) => a.timestamp_ms - b.timestamp_ms)[0] ?? null;
        const endWeight = settle ? settle.end_weight : pulse.end_weight;
        return {
            label: `Pulse ${pulse.pulse_attempt_number}`,
            durationMs: pulse.pulse_duration_ms,
            startWeight: pulse.start_weight,
            endWeight,
            yieldG: endWeight - pulse.start_weight,
            expectedYield: (pulse.pulse_duration_ms / 1000) * pulseFlowRate,
            settlingMs: settle ? settle.duration_ms : 0,
        };
    });
    return { rows, pulseFlowRate };
}

type PulseResult =
    | { kind: 'not-weight' }
    | { kind: 'no-pulses' }
    | {
          kind: 'ok';
          rows: PulseRow[];
          pulseFlowRate: number;
          totalYield: number;
          contributionFigure: Figure;
          durationFigure: Figure;
          accuracyFigure: Figure;
          detailFigure: Figure | null;
      };

function buildPulse(
    record: StoredRecord,
    includeTaring: boolean,
    smoothingMs: number,
): PulseResult {
    if ((MODE_MAP[record.session.grind_mode] ?? 'WEIGHT') !== 'WEIGHT')
        return { kind: 'not-weight' };
    const events = filterForDisplay(record.events, includeTaring);
    const { rows, pulseFlowRate } = pulseSummary(events);
    if (!rows.length) return { kind: 'no-pulses' };

    const totalYield = rows.reduce((sum, r) => sum + r.yieldG, 0);

    // Three small charts: contribution, effectiveness, prediction accuracy
    const contributionFigure: Figure = {
        traces: [
            {
                type: 'bar',
                x: rows.map((r) => r.label),
                y: rows.map((r) => r.yieldG),
                text: rows.map((r) => `${r.yieldG.toFixed(2)}g`),
                textposition: 'auto',
                marker: { color: COLOR_WEIGHT },
                hovertemplate: '%{x}: %{y:.3f}g<extra></extra>',
            },
        ],
        layout: chartLayout('Pulse Contribution', 'Pulse', 'Pulse Yield (g)'),
        config: CHART_CONFIG,
    };

    const durationFigure: Figure = {
        traces: [
            {
                x: rows.map((r) => r.durationMs),
                y: rows.map((r) => r.yieldG),
                mode: 'markers',
                marker: { size: 10, color: COLOR_WEIGHT },
                text: rows.map((r) => r.label),
                hovertemplate: '%{text}<br>Duration: %{x} ms<br>Yield: %{y:.3f}g<extra></extra>',
            },
        ],
        layout: chartLayout('Duration vs. Yield', 'Pulse Duration (ms)', 'Pulse Yield (g)'),
        config: CHART_CONFIG,
    };

    const accuracyValues = rows.flatMap((r) => [r.expectedYield, r.yieldG]);
    const accMin = Math.min(...accuracyValues);
    const accMax = Math.max(...accuracyValues);
    const accuracyFigure: Figure = {
        traces: [
            {
                x: rows.map((r) => r.expectedYield),
                y: rows.map((r) => r.yieldG),
                mode: 'markers',
                marker: { size: 10, color: COLOR_WEIGHT },
                text: rows.map((r) => r.label),
                name: 'Pulses',
                hovertemplate: '%{text}<br>Expected: %{x:.3f}g<br>Actual: %{y:.3f}g<extra></extra>',
            },
            {
                x: [accMin, accMax],
                y: [accMin, accMax],
                mode: 'lines',
                line: { dash: 'dash', color: COLOR_REFERENCE_LINE },
                name: 'Perfect Prediction',
                hoverinfo: 'skip',
            },
        ],
        layout: chartLayout(
            'Expected vs. Actual Yield',
            'Expected Yield (g)',
            'Actual Pulse Yield (g)',
        ),
        config: CHART_CONFIG,
    };

    // Detail chart over the pulse-phase measurements
    const pulsePhases = ['PULSE_EXECUTE', 'PULSE_SETTLING', 'PULSE_DECISION'];
    const pulseMeasurements = filterForDisplay(record.measurements, includeTaring)
        .filter((m) => pulsePhases.includes(m.phase_name))
        .sort((a, b) => a.timestamp_ms - b.timestamp_ms);
    const detailFigure = pulseMeasurements.length
        ? buildPhaseFigure({
              title: 'Pulse & Settling Details',
              measurements: pulseMeasurements,
              flowValues: smoothedFlow(pulseMeasurements, smoothingMs),
              fullMeasurements: record.measurements,
              events: events.filter((e) => pulsePhases.includes(e.phase_name)),
          })
        : null;

    return {
        kind: 'ok',
        rows,
        pulseFlowRate,
        totalYield,
        contributionFigure,
        durationFigure,
        accuracyFigure,
        detailFigure,
    };
}

const PULSE_TABLE_HEADERS = [
    'Pulse #',
    'Duration (ms)',
    'Start Weight (g)',
    'End Weight (g)',
    'Pulse Yield (g)',
    'Expected Yield (g)',
    'Settling Time (ms)',
];

export function PulseTab({
    record,
    includeTaring,
    smoothingMs,
}: {
    record: StoredRecord;
    includeTaring: boolean;
    smoothingMs: number;
}) {
    const result = useMemo(
        () => buildPulse(record, includeTaring, smoothingMs),
        [record, includeTaring, smoothingMs],
    );

    if (result.kind === 'not-weight') {
        return <InfoBox text="Pulse analysis is only available for grind-by-weight sessions." />;
    }
    if (result.kind === 'no-pulses') {
        return <InfoBox text="No pulse phase data found for this session." />;
    }

    return (
        <>
            <div className="my-4 grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-3 lg:grid-cols-5">
                <MetricTile label="Total Pulse Yield (g)" value={result.totalYield.toFixed(2)} />
                <MetricTile label="Number of Pulses" value={String(result.rows.length)} />
                <MetricTile label="Pulse Flow Rate (g/s)" value={result.pulseFlowRate.toFixed(3)} />
            </div>

            <h4>Pulse Summary</h4>
            <div className="mb-5 overflow-x-auto">
                <table className="w-full border-collapse font-mono text-sm tabular-nums [&_td]:whitespace-nowrap [&_td]:border-b [&_td]:py-1.5 [&_td]:pr-4 [&_th]:whitespace-nowrap [&_th]:border-b [&_th]:py-1.5 [&_th]:pr-4 [&_th]:text-left [&_th]:font-sans [&_th]:font-medium [&_th]:text-muted-foreground [&_th]:text-xs [&_tbody_tr:last-child_td]:border-b-0">
                    <thead>
                        <tr>
                            {PULSE_TABLE_HEADERS.map((h) => (
                                <th key={h}>{h}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {result.rows.map((r) => (
                            <tr key={r.label}>
                                <td>{r.label}</td>
                                <td>{r.durationMs.toFixed(0)}</td>
                                <td>{r.startWeight.toFixed(3)}</td>
                                <td>{r.endWeight.toFixed(3)}</td>
                                <td>{r.yieldG.toFixed(3)}</td>
                                <td>{r.expectedYield.toFixed(3)}</td>
                                <td>{String(r.settlingMs)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <div className="my-4 grid gap-4 md:grid-cols-2">
                <PlotlyChart figure={result.contributionFigure} small />
                <PlotlyChart figure={result.durationFigure} small />
                <PlotlyChart figure={result.accuracyFigure} small />
            </div>

            {result.detailFigure && <PlotlyChart figure={result.detailFigure} />}
        </>
    );
}

// --- Vibration Analysis tab -----------------------------------------------

function spectrumFigure(
    title: string,
    freqs: number[],
    amps: number[],
    color: string,
    fs: number,
    annotation: Record<string, unknown> | null = null,
): Figure {
    const layout = chartLayout(title, 'Frequency (Hz)', 'Amplitude') as Record<string, unknown>;
    layout.xaxis = { ...(layout.xaxis as Record<string, unknown>), range: [0, fs / 2] };
    if (annotation) layout.annotations = [annotation];
    return {
        traces: [
            {
                type: 'bar',
                x: freqs,
                y: amps,
                marker: { color },
                hovertemplate: '%{x:.2f} Hz: %{y:.4f}<extra></extra>',
            },
        ],
        layout,
        config: CHART_CONFIG,
    };
}

type VibrationBase =
    | { kind: 'insufficient' }
    | {
          kind: 'ok';
          sampleCount: number;
          durationS: number;
          samplingRate: number;
          detrended: number[];
          peakFreq: number | null;
          jitterFigure: Figure;
          rawFigure: Figure;
      };

function buildVibrationBase(record: StoredRecord): VibrationBase {
    const samples = record.measurements
        .filter((m) => m.phase_name === 'PREDICTIVE' && m.motor_is_on === 1)
        .sort((a, b) => a.timestamp_ms - b.timestamp_ms);

    if (samples.length < 20) return { kind: 'insufficient' };

    const times = samples.map((m) => m.timestamp_ms);
    const firstTs = times[0] ?? 0;
    const lastTs = times[times.length - 1] ?? 0;
    const durationS = (lastTs - firstTs) / 1000;
    const samplingRate = durationS > 0 ? samples.length / durationS : 0;
    const detrended = detrendLinear(samples.map((m) => m.weight_grams));
    const { freqs, amps } = amplitudeSpectrum(detrended, samplingRate);

    // Time-domain jitter
    const jitterLayout = chartLayout('', 'Time (ms)', 'Weight Fluctuation (g)') as Record<
        string,
        unknown
    >;
    jitterLayout.margin = { ...(jitterLayout.margin as Record<string, unknown>), t: 20 };
    const jitterFigure: Figure = {
        traces: [
            {
                x: times,
                y: detrended,
                mode: 'lines',
                name: 'Weight Jitter',
                line: { color: COLOR_WEIGHT, width: 1.5 },
                hovertemplate: '%{x} ms: %{y:.4f}g<extra></extra>',
            },
        ],
        layout: jitterLayout,
        config: CHART_CONFIG,
    };

    // Raw spectrum with peak
    let peakFreq: number | null = null;
    let peakAnnotation: Record<string, unknown> | null = null;
    if (freqs.length > 1) {
        let peakIdx = 1;
        for (let i = 2; i < amps.length; i++) {
            const current = amps[i];
            const best = amps[peakIdx];
            if (current !== undefined && best !== undefined && current > best) peakIdx = i;
        }
        const freq = freqs[peakIdx];
        const amp = amps[peakIdx];
        if (freq !== undefined && amp !== undefined) {
            peakFreq = freq;
            peakAnnotation = {
                x: freq,
                y: amp,
                text: `Peak: ${freq.toFixed(1)} Hz`,
                showarrow: true,
                arrowhead: 1,
            };
        }
    }
    const rawFigure = spectrumFigure(
        'Raw Signal Spectrum',
        freqs,
        amps,
        COLOR_WEIGHT,
        samplingRate,
        peakAnnotation,
    );

    return {
        kind: 'ok',
        sampleCount: samples.length,
        durationS,
        samplingRate,
        detrended,
        peakFreq,
        jitterFigure,
        rawFigure,
    };
}

const VIBRATION_HINT =
    'High-frequency "jitter" in the weight signal during the predictive phase while the motor runs. ' +
    'An FFT of the detrended signal reveals the dominant vibration frequencies from the motor and ' +
    'burrs — useful for tuning filters and understanding mechanical behaviour.';

export function VibrationTab({ record }: { record: StoredRecord; includeTaring: boolean }) {
    const [showIir, setShowIir] = useState(false);
    const [alpha, setAlpha] = useState(0.25);
    const [showNotch, setShowNotch] = useState(false);
    const [notchFreq, setNotchFreq] = useState(0.2);
    const [q, setQ] = useState(5);

    const base = useMemo(() => buildVibrationBase(record), [record]);

    const iirFigure = useMemo(() => {
        if (base.kind !== 'ok' || !showIir) return null;
        const filtered = lfilter([alpha], [1, alpha - 1], base.detrended);
        const spectrum = amplitudeSpectrum(filtered, base.samplingRate);
        return spectrumFigure(
            `IIR Filter Effect on Spectrum (α=${alpha.toFixed(2)})`,
            spectrum.freqs,
            spectrum.amps,
            COLOR_IIR,
            base.samplingRate,
        );
    }, [base, showIir, alpha]);

    const notchResult = useMemo(() => {
        if (base.kind !== 'ok' || !showNotch) return null;
        if (!(base.samplingRate > 0) || notchFreq >= base.samplingRate / 2) {
            return {
                kind: 'warning' as const,
                text: `Notch frequency must be below the Nyquist frequency (${(base.samplingRate / 2).toFixed(1)} Hz).`,
            };
        }
        const { b, a } = iirnotch(notchFreq, q, base.samplingRate);
        const filtered = lfilter(b, a, base.detrended);
        const spectrum = amplitudeSpectrum(filtered, base.samplingRate);
        return {
            kind: 'figure' as const,
            figure: spectrumFigure(
                `Notch Filter Effect on Spectrum (${notchFreq.toFixed(1)} Hz, Q=${q.toFixed(0)})`,
                spectrum.freqs,
                spectrum.amps,
                COLOR_NOTCH,
                base.samplingRate,
            ),
        };
    }, [base, showNotch, notchFreq, q]);

    if (base.kind === 'insufficient') {
        return (
            <>
                <p className="mb-3 text-muted-foreground text-xs">{VIBRATION_HINT}</p>
                <Note tone="caution">
                    Not enough data in the predictive phase with the motor on to perform vibration
                    analysis.
                </Note>
            </>
        );
    }

    return (
        <>
            <p className="mb-3 text-muted-foreground text-xs">{VIBRATION_HINT}</p>
            <p className="mb-3 text-muted-foreground text-xs">
                {`Analyzing ${base.sampleCount} data points over ${base.durationS.toFixed(2)} seconds. ` +
                    `Average sampling rate: ${base.samplingRate.toFixed(1)} Hz.`}
            </p>

            <h4>Vibration Signal (Time Domain)</h4>
            <PlotlyChart figure={base.jitterFigure} small />

            <h4>Raw Frequency Spectrum (FFT)</h4>
            {base.peakFreq !== null && (
                <div className="my-4 grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-3 lg:grid-cols-5">
                    <MetricTile
                        label="Peak Vibration Frequency"
                        value={`${base.peakFreq.toFixed(1)} Hz`}
                    />
                </div>
            )}
            <PlotlyChart figure={base.rawFigure} small />

            <h4>IIR Filter Analysis</h4>
            <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-3 border-b pb-3">
                <div className="flex items-center gap-2">
                    <Checkbox
                        id="show-iir"
                        checked={showIir}
                        onCheckedChange={(checked) => setShowIir(checked === true)}
                    />
                    <Label htmlFor="show-iir" className="font-normal text-muted-foreground">
                        Show IIR filtered spectrum
                    </Label>
                </div>
                <label className="flex items-center gap-2 text-muted-foreground text-sm">
                    {'Alpha '}
                    <input
                        type="range"
                        min={0.01}
                        max={0.99}
                        step={0.01}
                        value={alpha}
                        onChange={(event) => setAlpha(Number(event.target.value))}
                    />
                    <span className="min-w-10 text-right font-mono text-sm tabular-nums">
                        {alpha.toFixed(2)}
                    </span>
                </label>
            </div>
            {iirFigure && <PlotlyChart figure={iirFigure} small />}

            <h4>Notch Filter Analysis</h4>
            <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-3 border-b pb-3">
                <div className="flex items-center gap-2">
                    <Checkbox
                        id="show-notch"
                        checked={showNotch}
                        onCheckedChange={(checked) => setShowNotch(checked === true)}
                    />
                    <Label htmlFor="show-notch" className="font-normal text-muted-foreground">
                        Show notch filtered spectrum
                    </Label>
                </div>
                <label className="flex items-center gap-2 text-muted-foreground text-sm">
                    {'Frequency (Hz) '}
                    <input
                        type="range"
                        min={0.1}
                        max={15.0}
                        step={0.1}
                        value={notchFreq}
                        onChange={(event) => setNotchFreq(Number(event.target.value))}
                    />
                    <span className="min-w-10 text-right font-mono text-sm tabular-nums">
                        {notchFreq.toFixed(1)}
                    </span>
                </label>
                <label className="flex items-center gap-2 text-muted-foreground text-sm">
                    {'Q factor '}
                    <input
                        type="range"
                        min={1}
                        max={50}
                        step={1}
                        value={q}
                        onChange={(event) => setQ(Number(event.target.value))}
                    />
                    <span className="min-w-10 text-right font-mono text-sm tabular-nums">
                        {q.toFixed(0)}
                    </span>
                </label>
            </div>
            {notchResult?.kind === 'warning' && <Note tone="caution">{notchResult.text}</Note>}
            {notchResult?.kind === 'figure' && <PlotlyChart figure={notchResult.figure} small />}
        </>
    );
}

// --- Controller Performance tab -------------------------------------------

const CONTROLLER_TABLE_HEADERS = [
    'Phase Name',
    'Duration (ms)',
    'Loop Count',
    'Frequency (Hz)',
    'Avg ms/loop',
];

export function ControllerTab({
    record,
    includeTaring,
}: {
    record: StoredRecord;
    includeTaring: boolean;
}) {
    const events = useMemo(
        () => filterForDisplay(record.events, includeTaring),
        [record, includeTaring],
    );

    return (
        <>
            <p className="mb-3 text-muted-foreground text-xs">
                {'Controller loop performance per phase. The grind controller targets a 20 ms loop interval (50 Hz); ' +
                    'lower frequencies indicate system load or blocking operations.'}
            </p>
            {!events.length ? (
                <InfoBox text="No event data available for this session." />
            ) : (
                <div className="mb-5 overflow-x-auto">
                    <table className="w-full border-collapse font-mono text-sm tabular-nums [&_td]:whitespace-nowrap [&_td]:border-b [&_td]:py-1.5 [&_td]:pr-4 [&_th]:whitespace-nowrap [&_th]:border-b [&_th]:py-1.5 [&_th]:pr-4 [&_th]:text-left [&_th]:font-sans [&_th]:font-medium [&_th]:text-muted-foreground [&_th]:text-xs [&_tbody_tr:last-child_td]:border-b-0">
                        <thead>
                            <tr>
                                {CONTROLLER_TABLE_HEADERS.map((h) => (
                                    <th key={h}>{h}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {events.map((e) => {
                                const frequency =
                                    e.duration_ms > 0 ? e.loop_count / (e.duration_ms / 1000) : 0;
                                const msPerLoop =
                                    e.loop_count > 0 ? e.duration_ms / e.loop_count : 0;
                                return (
                                    <tr key={e.event_sequence_id}>
                                        <td>{e.phase_name}</td>
                                        <td>{String(e.duration_ms)}</td>
                                        <td>{String(e.loop_count)}</td>
                                        <td>{frequency.toFixed(1)}</td>
                                        <td>{msPerLoop.toFixed(2)}</td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </>
    );
}
