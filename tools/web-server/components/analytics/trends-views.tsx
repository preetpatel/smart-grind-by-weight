'use client';

// Trends view (long-term drift + wear odometer) and Compare view (aligned
// multi-session weight-curve overlay). Port of the flasher's
// tools/web-flasher/analytics/views-trends.js.
//
// Trends plot per-session metrics against session ID: error, the firmware's
// predictive flow-rate estimate, grind latency, and pulse count — flow decline
// and latency growth are the burr-wear/clogging early-warning signals. The
// odometer row comes from the firmware's lifetime statistics (captured with
// the device health snapshot), so grinds done with logging off still count.

import { useMemo, useState } from 'react';
import { MetricTile } from '@/components/analytics/metric';
import { ResultBadge } from '@/components/analytics/result-badge';
import { PlotlyChart } from '@/components/plotly-chart';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import type { Figure } from '@/lib/analytics/figures';
import {
    CHART_CONFIG,
    COLOR_TARGET,
    COLOR_WEIGHT,
    chartLayout,
    filterForDisplay,
} from '@/lib/analytics/figures';
import type { DeviceReports, StoredRecord } from '@/lib/analytics/types';
import { isEpochTimestamp, TOLERANCE_G } from '@/lib/analytics/types';
import type { ParsedGrindSession } from '@/lib/parser';
import { MODE_MAP } from '@/lib/parser';

const COLOR_PERFECT = '#58c97d'; // --success, lifted for the dark surface
const COLOR_SETTING = '#b950b2'; // detection magenta — annotation markers

// Sequential blue ramp for the compare overlay, light -> dark. On the dark
// chart surface the lightest step is the most prominent, so the NEWEST
// selected session gets the lightest color and older ones recede.
const RECENCY_RAMP = [
    '#cde2fb',
    '#b7d3f6',
    '#9ec5f4',
    '#86b6ef',
    '#6da7ec',
    '#5598e7',
    '#3987e5',
    '#2a78d6',
    '#256abf',
    '#1c5cab',
];
const COMPARE_MAX_SESSIONS = 10;

function InfoBox({ children }: { children: React.ReactNode }) {
    return <div className="my-4 text-muted-foreground text-sm">{children}</div>;
}

function formatRuntime(totalSeconds: number): string {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
    if (m > 0) return `${m}m ${String(totalSeconds % 60).padStart(2, '0')}s`;
    return `${totalSeconds % 60}s`;
}

function sessionDateLabel(session: ParsedGrindSession): string {
    return isEpochTimestamp(session.session_timestamp)
        ? new Date(session.session_timestamp * 1000).toLocaleDateString([], {
              month: 'short',
              day: 'numeric',
          })
        : `#${session.session_id}`;
}

// --- Trends ----------------------------------------------------------------

interface TrendRow {
    sessionId: number;
    date: string;
    error: number;
    flowRate: number | null;
    latencyMs: number | null;
    pulses: number;
    cumGrams: number;
}

type TrendValueKey = 'error' | 'flowRate' | 'latencyMs' | 'pulses';

// Per-session trend metrics from weight-mode sessions, in session-id order.
function trendRows(records: StoredRecord[]): TrendRow[] {
    const rows: TrendRow[] = [];
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

// Vertical rules where the grind setting changed, annotated with the new
// value. This is the whole point of recording the setting: a step in flow rate
// or latency should line up with the day the burrs moved, and until now that
// correlation had to be held in your head.
export interface SettingChange {
    sessionId: number;
    setting: string;
}

function settingChangeShapes(changes: SettingChange[]): {
    shapes: Record<string, unknown>[];
    annotations: Record<string, unknown>[];
} {
    return {
        shapes: changes.map((change) => ({
            type: 'line',
            xref: 'x',
            yref: 'paper',
            x0: change.sessionId,
            x1: change.sessionId,
            y0: 0,
            y1: 1,
            line: { color: COLOR_SETTING, width: 1, dash: 'dot' },
        })),
        annotations: changes.map((change) => ({
            x: change.sessionId,
            y: 1,
            xref: 'x',
            yref: 'paper',
            text: change.setting,
            showarrow: false,
            yanchor: 'bottom',
            font: { size: 10, color: COLOR_SETTING },
        })),
    };
}

function trendFigure(
    rows: TrendRow[],
    valueKey: TrendValueKey,
    title: string,
    yTitle: string,
    options: { shapes?: Record<string, unknown>[]; settingChanges?: SettingChange[] } = {},
): Figure {
    const points = rows
        .map((row) => ({ row, value: row[valueKey] }))
        .filter(
            (point): point is { row: TrendRow; value: number } =>
                point.value !== null && point.value !== undefined,
        );
    const layout: Record<string, unknown> = { ...chartLayout(title, 'Session ID', yTitle) };
    const marks = settingChangeShapes(options.settingChanges ?? []);
    const shapes = [...(options.shapes ?? []), ...marks.shapes];
    if (shapes.length) layout.shapes = shapes;
    if (marks.annotations.length) layout.annotations = marks.annotations;
    // Room for the setting labels sitting above the plot.
    if (marks.annotations.length) layout.margin = { t: 56, r: 20, b: 45, l: 55 };
    return {
        traces: [
            {
                x: points.map((p) => p.row.sessionId),
                y: points.map((p) => p.value),
                mode: 'lines+markers',
                marker: { size: 7, color: COLOR_WEIGHT },
                line: { color: 'rgba(57,135,229,0.35)', width: 1.5 },
                customdata: points.map((p) => [p.row.date, p.row.cumGrams.toFixed(0)]),
                hovertemplate:
                    `Session %{x} (%{customdata[0]})<br>${yTitle}: %{y:.3f}` +
                    '<br>Cumulative: %{customdata[1]} g ground<extra></extra>',
            },
        ],
        layout,
        config: CHART_CONFIG,
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

function lifetimeStats(deviceReports: DeviceReports | null): Record<string, unknown> | null {
    const raw = deviceReports?.system_info?.sessions?.lifetime;
    return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
}

function lifetimeNumber(lifetime: Record<string, unknown>, key: string): number {
    const value = lifetime[key];
    return typeof value === 'number' ? value : 0;
}

export function TrendsView({
    records,
    deviceReports,
    settingChanges = [],
}: {
    records: StoredRecord[];
    deviceReports: DeviceReports | null;
    settingChanges?: SettingChange[];
}) {
    // Wear odometer from the firmware's lifetime statistics: counts every
    // grind ever done on this device, not just the logged sessions below.
    const lifetime = useMemo(() => lifetimeStats(deviceReports), [deviceReports]);
    const rows = useMemo(() => trendRows(records), [records]);
    const figures = useMemo(() => {
        if (rows.length < 2) return null;
        return {
            error: trendFigure(rows, 'error', 'Weight Error', 'Error (g)', {
                shapes: [
                    hline(TOLERANCE_G, COLOR_TARGET),
                    hline(-TOLERANCE_G, COLOR_TARGET),
                    hline(0, COLOR_PERFECT, 'solid'),
                ],
                settingChanges,
            }),
            flowRate: trendFigure(rows, 'flowRate', 'Predictive Flow Rate', 'Flow (g/s)', {
                settingChanges,
            }),
            latencyMs: trendFigure(rows, 'latencyMs', 'Grind Latency', 'Latency (ms)', {
                settingChanges,
            }),
            pulses: trendFigure(rows, 'pulses', 'Pulse Count', 'Pulses', { settingChanges }),
        };
    }, [rows, settingChanges]);

    return (
        <>
            {lifetime ? (
                <>
                    <h4>Lifetime (device odometer)</h4>
                    <div className="my-4 grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-3 lg:grid-cols-5">
                        <MetricTile
                            label="Coffee Through Burrs"
                            value={`${lifetimeNumber(lifetime, 'total_weight_kg').toFixed(2)} kg`}
                            delta="typical burr life is quoted in kg"
                        />
                        <MetricTile
                            label="Total Grinds"
                            value={String(lifetimeNumber(lifetime, 'total_grinds'))}
                            delta={`${lifetimeNumber(lifetime, 'weight_mode_grinds')} weight · ${lifetimeNumber(lifetime, 'time_mode_grinds')} time`}
                        />
                        <MetricTile
                            label="Motor Runtime"
                            value={formatRuntime(lifetimeNumber(lifetime, 'motor_runtime_sec'))}
                        />
                        <MetricTile
                            label="Total Pulses"
                            value={String(lifetimeNumber(lifetime, 'total_pulses'))}
                        />
                        <MetricTile
                            label="Avg |Error|"
                            value={`${lifetimeNumber(lifetime, 'avg_accuracy_g').toFixed(3)} g`}
                        />
                    </div>
                </>
            ) : (
                <InfoBox>
                    No lifetime statistics captured yet — pull data from a grinder running firmware
                    with the extended health snapshot to see the wear odometer.
                </InfoBox>
            )}

            {figures === null ? (
                <InfoBox>Trends need at least two logged weight-mode sessions.</InfoBox>
            ) : (
                <>
                    <h4>{`Drift across ${rows.length} logged sessions`}</h4>
                    <p className="mb-3 text-muted-foreground text-xs">
                        Watch for flow rate declining and grind latency growing over time — both are
                        early signs of burr wear or clogging. Error and pulse count show whether the
                        controller is compensating.
                    </p>
                    <div className="my-4 grid gap-4 md:grid-cols-2">
                        <PlotlyChart figure={figures.error} small />
                        <PlotlyChart figure={figures.flowRate} small />
                        <PlotlyChart figure={figures.latencyMs} small />
                        <PlotlyChart figure={figures.pulses} small />
                    </div>
                </>
            )}
        </>
    );
}

// --- Compare ---------------------------------------------------------------

// Alignment origin: start of the main grind (PREDICTIVE for weight mode,
// TIME_GRINDING for time mode), falling back to the first measurement.
function alignmentOrigin(record: StoredRecord): number {
    const main =
        record.events.find((e) => e.phase_name === 'PREDICTIVE') ||
        record.events.find((e) => e.phase_name === 'TIME_GRINDING');
    if (main) return main.timestamp_ms;
    const displayed = filterForDisplay(record.measurements, false);
    return displayed[0]?.timestamp_ms ?? 0;
}

function buildCompareFigure(selectedRecords: StoredRecord[], showFlow: boolean): Figure {
    // Newest first so the ramp assigns the lightest (most prominent) color to
    // the most recent grind; older curves recede into darker blues.
    const sorted = [...selectedRecords].sort((a, b) => b.session_id - a.session_id);
    const traces: Record<string, unknown>[] = [];

    sorted.forEach((record, rank) => {
        const color = RECENCY_RAMP[Math.min(rank, RECENCY_RAMP.length - 1)] ?? '#1c5cab';
        const t0 = alignmentOrigin(record);
        const measurements = record.measurements
            .filter((m) => m.timestamp_ms >= t0)
            .sort((a, b) => a.timestamp_ms - b.timestamp_ms);
        const xs = measurements.map((m) => m.timestamp_ms - t0);
        traces.push({
            x: xs,
            y: measurements.map((m) => m.weight_grams),
            mode: 'lines',
            name: `#${record.session_id}`,
            line: { color, width: rank === 0 ? 2.5 : 1.5 },
            hovertemplate: `#${record.session_id}: %{y:.2f}g at %{x}ms<extra></extra>`,
        });
        if (showFlow) {
            traces.push({
                x: xs,
                y: measurements.map((m) => m.flow_rate_g_per_s),
                mode: 'lines',
                name: `#${record.session_id} flow`,
                line: { color, width: 1, dash: 'dot' },
                yaxis: 'y2',
                showlegend: false,
                hovertemplate: `#${record.session_id} flow: %{y:.2f}g/s<extra></extra>`,
            });
        }
    });

    const layout: Record<string, unknown> = {
        ...chartLayout(
            'Aligned Grind Curves (t=0 at grind start)',
            'Time from grind start (ms)',
            'Weight (g)',
        ),
    };
    layout.showlegend = true;
    layout.legend = {
        yanchor: 'top',
        y: 0.99,
        xanchor: 'left',
        x: 0.01,
        bgcolor: 'rgba(28,25,23,0.85)',
    };
    if (showFlow) {
        layout.yaxis2 = {
            title: { text: 'Flow (g/s)' },
            overlaying: 'y',
            side: 'right',
            showgrid: false,
            zeroline: false,
        };
    }

    // Single shared target line when every selected session aims at the same weight.
    const targets = new Set(
        sorted
            .filter((r) => (MODE_MAP[r.session.grind_mode] ?? 'WEIGHT') === 'WEIGHT')
            .map((r) => r.session.target_weight.toFixed(2)),
    );
    if (targets.size === 1 && sorted.length) {
        const target = Number([...targets][0]);
        layout.shapes = [
            {
                type: 'line',
                xref: 'paper',
                yref: 'y',
                x0: 0,
                x1: 1,
                y0: target,
                y1: target,
                line: { color: COLOR_TARGET, width: 1.5, dash: 'dash' },
            },
        ];
        layout.annotations = [
            {
                xref: 'paper',
                yref: 'y',
                x: 0.99,
                y: target,
                text: 'Target',
                showarrow: false,
                yanchor: 'bottom',
                font: { size: 11, color: COLOR_TARGET },
            },
        ];
    }

    return { traces, layout, config: CHART_CONFIG };
}

export function CompareView({
    records,
    initialSessionIds,
}: {
    records: StoredRecord[];
    initialSessionIds?: number[];
}) {
    const [initialized, setInitialized] = useState(false);
    const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set<number>());
    const [showFlow, setShowFlow] = useState(false);

    // First visit with data present: honour a selection handed over from the
    // sessions table, otherwise preselect the two newest so the chart isn't
    // empty. (Render-time state adjustment, mirroring the original's one-shot
    // `initialized` flag.)
    if (records.length > 0 && !initialized) {
        setInitialized(true);
        setSelected(
            new Set(
                initialSessionIds?.length
                    ? initialSessionIds.slice(0, COMPARE_MAX_SESSIONS)
                    : records.slice(-2).map((record) => record.session_id),
            ),
        );
    }

    // Drop selections that no longer exist (cleared/re-pulled data).
    const selectedIds = useMemo(() => {
        const ids = new Set<number>();
        for (const record of records) {
            if (selected.has(record.session_id)) ids.add(record.session_id);
        }
        return ids;
    }, [records, selected]);

    const selectedRecords = useMemo(
        () => records.filter((record) => selectedIds.has(record.session_id)),
        [records, selectedIds],
    );

    const figure = useMemo(
        () => (selectedRecords.length ? buildCompareFigure(selectedRecords, showFlow) : null),
        [selectedRecords, showFlow],
    );

    if (!records.length) {
        return <InfoBox>No sessions stored yet.</InfoBox>;
    }

    const atCap = selectedIds.size >= COMPARE_MAX_SESSIONS;
    const toggleSession = (sessionId: number, checked: boolean) => {
        const next = new Set(selectedIds);
        if (checked) next.add(sessionId);
        else next.delete(sessionId);
        setSelected(next);
    };

    const headers = ['', 'ID', 'Started', 'Mode', 'Target', 'Final (g)', 'Error', 'Result'];

    return (
        <>
            <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-3 border-b pb-3">
                <span className="flex items-center gap-2 text-muted-foreground text-sm">
                    {`${selectedRecords.length}/${COMPARE_MAX_SESSIONS} sessions selected`}
                </span>
                <div className="flex items-center gap-2">
                    <Checkbox
                        id="compare-show-flow"
                        checked={showFlow}
                        onCheckedChange={(checked) => setShowFlow(checked === true)}
                    />
                    <Label
                        htmlFor="compare-show-flow"
                        className="font-normal text-muted-foreground"
                    >
                        Show flow rate
                    </Label>
                </div>
            </div>

            {figure ? (
                <PlotlyChart figure={figure} />
            ) : (
                <InfoBox>Select sessions below to overlay their grind curves.</InfoBox>
            )}

            {/* Selection table, newest first. */}
            <div className="mb-5 max-h-96 overflow-auto">
                <table className="w-full border-collapse font-mono text-sm tabular-nums [&_td]:whitespace-nowrap [&_td]:border-b [&_td]:py-1.5 [&_td]:pr-4 [&_th]:whitespace-nowrap [&_th]:border-b [&_th]:py-1.5 [&_th]:pr-4 [&_th]:text-left [&_th]:font-sans [&_th]:font-medium [&_th]:text-muted-foreground [&_th]:text-xs [&_tbody_tr:last-child_td]:border-b-0">
                    <thead>
                        <tr>
                            {headers.map((header) => (
                                <th key={header || 'select'}>{header}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {[...records].reverse().map((record) => {
                            const s = record.session;
                            const checked = selectedIds.has(s.session_id);
                            const mode = MODE_MAP[s.grind_mode] ?? 'WEIGHT';
                            const error =
                                mode === 'TIME'
                                    ? `${s.time_error_ms / 1000 >= 0 ? '+' : ''}${(s.time_error_ms / 1000).toFixed(2)}s`
                                    : `${s.final_weight - s.target_weight >= 0 ? '+' : ''}${(s.final_weight - s.target_weight).toFixed(2)}g`;
                            const target =
                                mode === 'TIME'
                                    ? `${(s.target_time_ms / 1000).toFixed(1)}s`
                                    : `${s.target_weight.toFixed(1)}g`;
                            const started = isEpochTimestamp(s.session_timestamp)
                                ? new Date(s.session_timestamp * 1000).toLocaleString([], {
                                      dateStyle: 'short',
                                      timeStyle: 'short',
                                  })
                                : 'uptime only';
                            return (
                                <tr key={record.sha256} className={checked ? 'selected' : ''}>
                                    <td>
                                        <Checkbox
                                            checked={checked}
                                            disabled={!checked && atCap}
                                            onCheckedChange={(value) =>
                                                toggleSession(s.session_id, value === true)
                                            }
                                        />
                                    </td>
                                    <td>{`#${s.session_id}`}</td>
                                    <td>{started}</td>
                                    <td>{mode}</td>
                                    <td>{target}</td>
                                    <td>{s.final_weight.toFixed(2)}</td>
                                    <td>{error}</td>
                                    <td>
                                        <ResultBadge status={s.result_status} />
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </>
    );
}
