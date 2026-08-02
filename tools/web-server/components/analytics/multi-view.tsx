'use client';

// Multi-Session Analysis: React port of the web flasher's comparative view
// (tools/web-flasher/analytics/views-multi.js) — overview statistics,
// predictive-phase tuning, and pulse effectiveness across a filtered set of
// sessions.

import { useMemo, useState } from 'react';
import { MetricTile } from '@/components/analytics/metric';
import { ResultBadge } from '@/components/analytics/result-badge';
import { PlotlyChart } from '@/components/plotly-chart';
import { Label } from '@/components/ui/label';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { Figure } from '@/lib/analytics/figures';
import { CHART_CONFIG, COLOR_WEIGHT, chartLayout, grindTimeSeconds } from '@/lib/analytics/figures';
import { mean, pearson, stddev } from '@/lib/analytics/frame';
import type { StoredRecord } from '@/lib/analytics/types';
import { TOLERANCE_G } from '@/lib/analytics/types';
import type { ParsedGrindSession } from '@/lib/parser';
import { MODE_MAP, PROFILE_MAP } from '@/lib/parser';

const COLOR_TOLERANCE = '#e66767';
const COLOR_PERFECT = '#58c97d'; // --success, lifted for the dark surface
const COLOR_REFERENCE = '#78716c'; // stone — chrome, not data
const COLOR_METHOD_ALT = '#d95926'; // 1500ms-average method, distinct from the 95p method

// Status colors: fixed identities from the reserved status palette, not cycled
// (COMPLETE=good, OVERSHOOT=warning, MAX_PULSES=serious, TIMEOUT=critical).
const STATUS_COLORS: Record<string, string> = {
    COMPLETE: '#0ca30c',
    OVERSHOOT: '#fab219',
    TIMEOUT: '#d03b3b',
    MAX_PULSES: '#ec835a',
};

const MULTI_TABS = [
    { key: 'overview', label: 'Session Overview' },
    { key: 'predictive', label: 'Predictive Analysis' },
    { key: 'pulses', label: 'Pulse Effectiveness' },
] as const;

type MultiTabKey = (typeof MULTI_TABS)[number]['key'];

interface MultiFilters {
    profile: string;
    mode: string;
    idMin: number;
    idMax: number;
}

function vline(x: number, color: string, dash = 'dash'): Record<string, unknown> {
    return {
        type: 'line',
        xref: 'x',
        yref: 'paper',
        x0: x,
        x1: x,
        y0: 0,
        y1: 1,
        line: { color, width: 1.5, dash },
    };
}

function hline(y: number, color: string, dash = 'dash'): Record<string, unknown> {
    return {
        type: 'line',
        xref: 'paper',
        yref: 'y',
        x0: 0,
        x1: 1,
        y0: y,
        y1: y,
        line: { color, width: 1.5, dash },
    };
}

// error_grams recomputed as final - target, as the report does for old data.
function errorOf(session: ParsedGrindSession): number {
    return session.final_weight - session.target_weight;
}

function applyMultiFilters(records: StoredRecord[], filters: MultiFilters): StoredRecord[] {
    return records.filter((r) => {
        const s = r.session;
        if (
            filters.mode !== 'All' &&
            (MODE_MAP[s.grind_mode] ?? 'WEIGHT') !== filters.mode.toUpperCase()
        )
            return false;
        if (
            filters.profile !== 'All' &&
            (PROFILE_MAP[s.profile_id] ?? String(s.profile_id)) !== filters.profile
        )
            return false;
        if (s.session_id < filters.idMin || s.session_id > filters.idMax) return false;
        return true;
    });
}

interface PredictiveRow {
    sessionId: number;
    motorStopTarget: number;
    grindLatencyMs: number;
    pulseFlowRate: number;
    coastingYield: number;
    predictiveError: number;
    finalError: number;
}

// Per-session derived data used by the predictive and pulse tabs.
function predictiveAnalysis(records: StoredRecord[]): PredictiveRow[] {
    const rows: PredictiveRow[] = [];
    for (const record of records) {
        const predictive = record.events.find((e) => e.phase_name === 'PREDICTIVE');
        if (!predictive) continue;
        const predEnd = predictive.timestamp_ms + predictive.duration_ms;
        const settle =
            record.events
                .filter(
                    (e) =>
                        ['PULSE_SETTLING', 'FINAL_SETTLING', 'PRIME_SETTLING'].includes(
                            e.phase_name,
                        ) && e.timestamp_ms >= predEnd,
                )
                .sort((a, b) => a.timestamp_ms - b.timestamp_ms)[0] ?? null;

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

interface PulseRow {
    sessionId: number;
    durationMs: number;
    pulseYield: number;
    expectedYield: number;
    expectedYield1500: number;
}

// merge_asof(direction='forward', tolerance=5000) equivalent: each pulse pairs
// with the first settling event that follows it within 5s in the same session.
function pulseAnalysis(records: StoredRecord[]): PulseRow[] {
    const rows: PulseRow[] = [];
    for (const record of records) {
        const predictive = record.events.find((e) => e.phase_name === 'PREDICTIVE');
        const pulseFlowRate = predictive ? predictive.pulse_flow_rate : 0;

        // Average flow over the last 1500ms of the predictive phase
        let avgFlow1500 = 0;
        if (predictive) {
            const predEnd = predictive.timestamp_ms + predictive.duration_ms;
            const windowMeasurements = record.measurements.filter(
                (m) =>
                    m.phase_name === 'PREDICTIVE' &&
                    m.timestamp_ms >= predEnd - 1500 &&
                    m.timestamp_ms <= predEnd,
            );
            avgFlow1500 = mean(windowMeasurements.map((m) => m.flow_rate_g_per_s));
        }

        const settles = record.events
            .filter((e) => e.phase_name === 'PULSE_SETTLING')
            .sort((a, b) => a.timestamp_ms - b.timestamp_ms);
        for (const pulse of record.events.filter((e) => e.phase_name === 'PULSE_EXECUTE')) {
            const settle =
                settles.find(
                    (s) =>
                        s.timestamp_ms >= pulse.timestamp_ms &&
                        s.timestamp_ms - pulse.timestamp_ms <= 5000,
                ) ?? null;
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

interface ScatterRow {
    sessionId: number;
    x: number;
    y: number;
}

function scatterWithIdentityLine(
    rows: ScatterRow[],
    title: string,
    xTitle: string,
    yTitle: string,
    color: string,
): Figure {
    const xs = rows.map((r) => r.x);
    const ys = rows.map((r) => r.y);
    const lo = Math.min(...xs, ...ys);
    const hi = Math.max(...xs, ...ys);
    return {
        traces: [
            {
                x: xs,
                y: ys,
                mode: 'markers',
                marker: { size: 8, opacity: 0.6, color },
                customdata: rows.map((r) => r.sessionId),
                hovertemplate: `Session %{customdata}<br>${xTitle}: %{x:.3f}<br>${yTitle}: %{y:.3f}<extra></extra>`,
            },
            {
                x: [lo, hi],
                y: [lo, hi],
                mode: 'lines',
                line: { dash: 'dash', color: COLOR_REFERENCE },
                hoverinfo: 'skip',
            },
        ],
        layout: { ...chartLayout(title, xTitle, yTitle) },
        config: CHART_CONFIG,
    };
}

function InfoBox({ text, type = 'info' }: { text: string; type?: 'info' | 'warning' }) {
    return <div className={`status ${type}`}>{text}</div>;
}

function OverviewTab({ records }: { records: StoredRecord[] }) {
    const data = useMemo(() => {
        const errors = records.map((r) => errorOf(r.session));
        const withinTolerance = errors.filter((e) => Math.abs(e) < TOLERANCE_G).length;
        const grindTimes = records.map((r) => grindTimeSeconds(r.events)).filter((t) => t > 0);
        const meanError = mean(errors);
        const errorStd = stddev(errors);

        // Error distribution histogram with tolerance guides
        const histogram: Figure = {
            traces: [
                {
                    type: 'histogram',
                    x: errors,
                    nbinsx: 20,
                    marker: { color: COLOR_WEIGHT },
                    hovertemplate: '%{x}: %{y} sessions<extra></extra>',
                },
            ],
            layout: {
                ...chartLayout('Weight Error Distribution', 'Error (g)', 'Count'),
                shapes: [
                    vline(TOLERANCE_G, COLOR_TOLERANCE),
                    vline(-TOLERANCE_G, COLOR_TOLERANCE),
                    vline(0, COLOR_PERFECT, 'solid'),
                ],
            },
            config: CHART_CONFIG,
        };

        // Result status breakdown
        const counts = new Map<string, number>();
        for (const r of records)
            counts.set(r.session.result_status, (counts.get(r.session.result_status) ?? 0) + 1);
        const labels = [...counts.keys()];
        const outcomes: Figure = {
            traces: [
                {
                    type: 'pie',
                    labels,
                    values: labels.map((l) => counts.get(l) ?? 0),
                    marker: { colors: labels.map((l) => STATUS_COLORS[l] ?? COLOR_REFERENCE) },
                    hovertemplate: '%{label}: %{value} sessions (%{percent})<extra></extra>',
                },
            ],
            layout: {
                ...chartLayout('Grind Outcomes', '', ''),
                showlegend: true,
                legend: { orientation: 'h' },
            },
            config: CHART_CONFIG,
        };

        // Trend over session id
        const trend: Figure = {
            traces: [
                {
                    x: records.map((r) => r.session_id),
                    y: errors,
                    mode: 'markers',
                    marker: { size: 7, opacity: 0.7, color: COLOR_WEIGHT },
                    hovertemplate: 'Session %{x}<br>Error: %{y:.3f}g<extra></extra>',
                },
            ],
            layout: {
                ...chartLayout('Error vs Session ID (Time Progression)', 'Session ID', 'Error (g)'),
                shapes: [
                    hline(TOLERANCE_G, COLOR_TOLERANCE),
                    hline(-TOLERANCE_G, COLOR_TOLERANCE),
                    hline(0, COLOR_PERFECT, 'solid'),
                ],
            },
            config: CHART_CONFIG,
        };

        return {
            accuracy: `${((withinTolerance / records.length) * 100).toFixed(1)}%`,
            averageError: `${meanError >= 0 ? '+' : ''}${meanError.toFixed(3)}g`,
            errorStdDev: Number.isNaN(errorStd) ? 'n/a' : `${errorStd.toFixed(3)}g`,
            avgGrindTime: `${mean(grindTimes).toFixed(1)}s`,
            histogram,
            outcomes,
            trend,
        };
    }, [records]);

    return (
        <div>
            <div className="my-4 grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-3 lg:grid-cols-5">
                <MetricTile label="Accuracy Rate" value={data.accuracy} />
                <MetricTile label="Average Error" value={data.averageError} />
                <MetricTile label="Error Std Dev" value={data.errorStdDev} />
                <MetricTile label="Avg Grind Time" value={data.avgGrindTime} />
            </div>
            <div className="my-4 grid gap-4 md:grid-cols-2">
                <PlotlyChart figure={data.histogram} small />
                <PlotlyChart figure={data.outcomes} small />
            </div>
            <PlotlyChart figure={data.trend} small />
        </div>
    );
}

function PredictiveTab({ records }: { records: StoredRecord[] }) {
    const data = useMemo(() => {
        const rows = predictiveAnalysis(records);
        if (!rows.length) return null;

        const avgPredictiveError = mean(rows.map((r) => r.predictiveError));
        const avgCoasting = mean(rows.map((r) => r.coastingYield));

        const motorStopHistogram: Figure = {
            traces: [
                {
                    type: 'histogram',
                    x: rows.map((r) => r.motorStopTarget),
                    nbinsx: 20,
                    marker: { color: COLOR_WEIGHT },
                },
            ],
            layout: {
                ...chartLayout(
                    'Motor Stop Target Weight Distribution',
                    'Undershoot Target (g)',
                    'Count',
                ),
            },
            config: CHART_CONFIG,
        };

        const coastingHistogram: Figure = {
            traces: [
                {
                    type: 'histogram',
                    x: rows.map((r) => r.coastingYield),
                    nbinsx: 20,
                    marker: { color: COLOR_WEIGHT },
                },
            ],
            layout: {
                ...chartLayout('Weight Gained During Coasting', 'Coasting Yield (g)', 'Count'),
                shapes: [vline(avgCoasting, COLOR_TOLERANCE)],
                annotations: [
                    {
                        x: avgCoasting,
                        y: 1,
                        yref: 'paper',
                        text: `Avg: ${avgCoasting.toFixed(3)}g`,
                        showarrow: false,
                        yanchor: 'bottom',
                    },
                ],
            },
            config: CHART_CONFIG,
        };

        const errorScatter = scatterWithIdentityLine(
            rows.map((r) => ({ sessionId: r.sessionId, x: r.predictiveError, y: r.finalError })),
            'Predictive Phase Error vs Final Error',
            'Predictive Error (g)',
            'Final Error (g)',
            COLOR_WEIGHT,
        );

        const latencyScatter: Figure = {
            traces: [
                {
                    x: rows.map((r) => r.grindLatencyMs),
                    y: rows.map((r) => r.finalError),
                    mode: 'markers',
                    marker: { size: 8, opacity: 0.7, color: COLOR_WEIGHT },
                    customdata: rows.map((r) => r.sessionId),
                    hovertemplate:
                        'Session %{customdata}<br>Latency: %{x}ms<br>Final Error: %{y:.3f}g<extra></extra>',
                },
            ],
            layout: {
                ...chartLayout(
                    'Grind Latency Impact on Final Accuracy',
                    'Grind Latency (ms)',
                    'Final Error (g)',
                ),
            },
            config: CHART_CONFIG,
        };

        return {
            avgUndershootTarget: `${mean(rows.map((r) => r.motorStopTarget)).toFixed(3)}g`,
            avgPredictiveError: `${avgPredictiveError >= 0 ? '+' : ''}${avgPredictiveError.toFixed(3)}g`,
            avgCoastingYield: `${avgCoasting.toFixed(3)}g`,
            avgGrindLatency: `${mean(rows.map((r) => r.grindLatencyMs)).toFixed(0)}ms`,
            avgFlowRate: `${mean(rows.map((r) => r.pulseFlowRate)).toFixed(3)}g/s`,
            motorStopHistogram,
            coastingHistogram,
            errorScatter,
            latencyScatter,
        };
    }, [records]);

    if (!data) {
        return <InfoBox text="No predictive phase data in the selected grinds." />;
    }

    return (
        <div>
            <div className="my-4 grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-3 lg:grid-cols-5">
                <MetricTile label="Avg Undershoot Target" value={data.avgUndershootTarget} />
                <MetricTile label="Avg Predictive Error" value={data.avgPredictiveError} />
                <MetricTile label="Avg Coasting Yield" value={data.avgCoastingYield} />
                <MetricTile label="Avg Grind Latency" value={data.avgGrindLatency} />
                <MetricTile label="Avg Flow Rate" value={data.avgFlowRate} />
            </div>
            <div className="my-4 grid gap-4 md:grid-cols-2">
                <PlotlyChart figure={data.motorStopHistogram} small />
                <PlotlyChart figure={data.coastingHistogram} small />
                <PlotlyChart figure={data.errorScatter} small />
            </div>
            <PlotlyChart figure={data.latencyScatter} small />
        </div>
    );
}

function PulsesTab({ records }: { records: StoredRecord[] }) {
    const data = useMemo(() => {
        const rows = pulseAnalysis(records);
        if (!rows.length) return null;

        const r95 = pearson(
            rows.map((r) => r.expectedYield),
            rows.map((r) => r.pulseYield),
        );
        const r1500 = pearson(
            rows.map((r) => r.expectedYield1500),
            rows.map((r) => r.pulseYield),
        );

        const durationScatter: Figure = {
            traces: [
                {
                    x: rows.map((r) => r.durationMs),
                    y: rows.map((r) => r.pulseYield),
                    mode: 'markers',
                    marker: { size: 8, opacity: 0.6, color: COLOR_WEIGHT },
                    customdata: rows.map((r) => r.sessionId),
                    hovertemplate:
                        '<b>Session %{customdata}</b><br>Duration: %{x} ms<br>Yield: %{y:.3f}g<extra></extra>',
                },
            ],
            layout: {
                ...chartLayout(
                    'Pulse Duration vs. Weight Added',
                    'Pulse Duration (ms)',
                    'Weight Added (g)',
                ),
            },
            config: CHART_CONFIG,
        };

        const scatter95 = scatterWithIdentityLine(
            rows.map((r) => ({ sessionId: r.sessionId, x: r.expectedYield, y: r.pulseYield })),
            `Expected vs. Actual (95th Percentile)${Number.isNaN(r95) ? '' : ` — r = ${r95.toFixed(3)}`}`,
            'Expected Yield (g)',
            'Actual Pulse Yield (g)',
            COLOR_WEIGHT,
        );

        const scatter1500 = scatterWithIdentityLine(
            rows.map((r) => ({ sessionId: r.sessionId, x: r.expectedYield1500, y: r.pulseYield })),
            `Expected vs. Actual (1500ms Average)${Number.isNaN(r1500) ? '' : ` — r = ${r1500.toFixed(3)}`}`,
            'Expected Yield (g)',
            'Actual Pulse Yield (g)',
            COLOR_METHOD_ALT,
        );

        return {
            pulsesAnalyzed: String(rows.length),
            r95: Number.isNaN(r95) ? 'r = n/a' : `r = ${r95.toFixed(3)}`,
            r1500: Number.isNaN(r1500) ? 'r = n/a' : `r = ${r1500.toFixed(3)}`,
            durationScatter,
            scatter95,
            scatter1500,
        };
    }, [records]);

    if (!data) {
        return <InfoBox text="No pulse data in the selected grinds." />;
    }

    return (
        <div>
            <p className="mb-3 text-muted-foreground text-xs">
                Each point is one PULSE_EXECUTE event. Pulse duration is calculated as (error /
                pulse_flow_rate); higher correlation between expected and actual yield means better
                pulse duration predictions.
            </p>
            <div className="my-4 grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-3 lg:grid-cols-5">
                <MetricTile label="Pulses Analyzed" value={data.pulsesAnalyzed} />
                <MetricTile label="95th Percentile Method" value={data.r95} />
                <MetricTile label="1500ms Average Method" value={data.r1500} />
            </div>
            <div className="my-4 grid gap-4 md:grid-cols-2">
                <PlotlyChart figure={data.durationScatter} small />
                <PlotlyChart figure={data.scatter95} small />
                <PlotlyChart figure={data.scatter1500} small />
            </div>
        </div>
    );
}

const TABLE_HEADERS = [
    'ID',
    'Profile',
    'Target (g)',
    'Final (g)',
    'Error (g)',
    'Pulses',
    'Result',
    'Motor On (s)',
    'Duration (s)',
];

function SessionsTable({ records }: { records: StoredRecord[] }) {
    return (
        <>
            <h4>Data from selected grinds</h4>
            <div className="mb-5 overflow-x-auto">
                <table className="w-full border-collapse font-mono text-sm tabular-nums [&_td]:whitespace-nowrap [&_td]:border-b [&_td]:py-1.5 [&_td]:pr-4 [&_th]:whitespace-nowrap [&_th]:border-b [&_th]:py-1.5 [&_th]:pr-4 [&_th]:text-left [&_th]:font-sans [&_th]:font-medium [&_th]:text-muted-foreground [&_th]:text-xs [&_tbody_tr:last-child_td]:border-b-0">
                    <thead>
                        <tr>
                            {TABLE_HEADERS.map((header) => (
                                <th key={header}>{header}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {records.map((r) => {
                            const s = r.session;
                            return (
                                <tr key={s.session_id}>
                                    <td>#{s.session_id}</td>
                                    <td>{PROFILE_MAP[s.profile_id] ?? `P${s.profile_id}`}</td>
                                    <td>{s.target_weight.toFixed(2)}</td>
                                    <td>{s.final_weight.toFixed(2)}</td>
                                    <td>{errorOf(s).toFixed(3)}</td>
                                    <td>{s.pulse_count}</td>
                                    <td>
                                        <ResultBadge status={s.result_status} />
                                    </td>
                                    <td>{(s.total_motor_on_time_ms / 1000).toFixed(2)}</td>
                                    <td>{(s.total_time_ms / 1000).toFixed(2)}</td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </>
    );
}

export function MultiView({ records }: { records: StoredRecord[] }) {
    const [profile, setProfile] = useState('All');
    const [mode, setMode] = useState('All');
    const [idMin, setIdMin] = useState<number>(() =>
        records.length ? Math.min(...records.map((r) => r.session_id)) : 0,
    );
    const [idMax, setIdMax] = useState<number>(() =>
        records.length ? Math.max(...records.map((r) => r.session_id)) : 0,
    );
    const [tab, setTab] = useState<MultiTabKey>('overview');

    const idBounds = useMemo(() => {
        const ids = records.map((r) => r.session_id);
        return ids.length ? { min: Math.min(...ids), max: Math.max(...ids) } : { min: 0, max: 0 };
    }, [records]);

    const profiles = useMemo(
        () => [
            'All',
            ...new Set(
                records.map(
                    (r) => PROFILE_MAP[r.session.profile_id] ?? String(r.session.profile_id),
                ),
            ),
        ],
        [records],
    );

    const filtered = useMemo(
        () => applyMultiFilters(records, { profile, mode, idMin, idMax }),
        [records, profile, mode, idMin, idMax],
    );

    const filteredModes = useMemo(
        () => new Set(filtered.map((r) => MODE_MAP[r.session.grind_mode] ?? 'WEIGHT')),
        [filtered],
    );

    let body: React.ReactNode;
    if (!filtered.length) {
        body = <InfoBox text="No grinds match the selected filters." type="warning" />;
    } else if (filteredModes.size > 1) {
        body = (
            <>
                <InfoBox text="Mixed modes — filter to one." type="warning" />
                <SessionsTable records={filtered} />
            </>
        );
    } else if (filteredModes.has('TIME')) {
        body = (
            <>
                <InfoBox text="Weight-mode grinds only." />
                <SessionsTable records={filtered} />
            </>
        );
    } else {
        body = (
            <>
                <Tabs value={tab} onValueChange={(value) => setTab(value as MultiTabKey)}>
                    <TabsList>
                        {MULTI_TABS.map((entry) => (
                            <TabsTrigger key={entry.key} value={entry.key}>
                                {entry.label}
                            </TabsTrigger>
                        ))}
                    </TabsList>
                    <TabsContent value="predictive">
                        <PredictiveTab records={filtered} />
                    </TabsContent>
                    <TabsContent value="pulses">
                        <PulsesTab records={filtered} />
                    </TabsContent>
                    <TabsContent value="overview">
                        <OverviewTab records={filtered} />
                    </TabsContent>
                </Tabs>
                <SessionsTable records={filtered} />
            </>
        );
    }

    return (
        <div>
            <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-3 border-b pb-3">
                <div className="flex items-center gap-2 text-muted-foreground text-sm">
                    <Label htmlFor="multi-profile" className="font-normal">
                        Profile
                    </Label>
                    <Select value={profile} onValueChange={(value) => setProfile(value ?? 'All')}>
                        <SelectTrigger id="multi-profile" size="sm" className="w-32">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {profiles.map((option) => (
                                <SelectItem key={option} value={option}>
                                    {option}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                <div className="flex items-center gap-2 text-muted-foreground text-sm">
                    <Label htmlFor="multi-mode" className="font-normal">
                        Mode
                    </Label>
                    <Select value={mode} onValueChange={(value) => setMode(value ?? 'All')}>
                        <SelectTrigger id="multi-mode" size="sm" className="w-28">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {['All', 'Weight', 'Time'].map((option) => (
                                <SelectItem key={option} value={option}>
                                    {option}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                <label className="flex items-center gap-2 text-muted-foreground text-sm">
                    From #
                    <input
                        type="number"
                        min={idBounds.min}
                        max={idBounds.max}
                        value={idMin}
                        style={{ width: '80px' }}
                        onChange={(e) => setIdMin(Number(e.target.value))}
                    />
                </label>
                <label className="flex items-center gap-2 text-muted-foreground text-sm">
                    To #
                    <input
                        type="number"
                        min={idBounds.min}
                        max={idBounds.max}
                        value={idMax}
                        style={{ width: '80px' }}
                        onChange={(e) => setIdMax(Number(e.target.value))}
                    />
                </label>
            </div>
            {body}
        </div>
    );
}
