'use client';

// The overview's opening statement: the last grind presented the way the
// device's own completion screen presents it, then how the machine has been
// doing across everything stored. Flat and divided rather than a wall of
// cards — at this density boxes read as noise.
import { grindTimeSeconds } from '@/lib/analytics/figures';
import { mean, stddev } from '@/lib/analytics/frame';
import { sessionErrorLabel, sessionStartLabel, sessionTargetLabel } from '@/lib/analytics/labels';
import { isEpochTimestamp, type StoredRecord, TOLERANCE_G } from '@/lib/analytics/types';
import { MODE_MAP, PROFILE_MAP } from '@/lib/parser';
import { cn } from '@/lib/utils';
import { ResultBadge } from './result-badge';

// Miniature of the multi-session "error vs session" chart: one point per
// weight-mode grind, tolerance band behind it, zero line through it. Points
// outside tolerance are coloured *and* outside the band — double encoding, so
// the reading survives colour-blindness and a greyscale print alike.
function ErrorSparkline({ weightRecords }: { weightRecords: StoredRecord[] }) {
    const W = 600;
    const H = 56;
    const PAD = 8;
    const points = weightRecords.map((r) => ({
        id: r.session_id,
        error: r.session.final_weight - r.session.target_weight,
    }));
    const maxAbs = Math.max(TOLERANCE_G * 1.6, ...points.map((p) => Math.abs(p.error)));
    const y = (v: number) => H / 2 - (v / maxAbs) * (H / 2 - PAD);
    const x = (i: number) =>
        points.length === 1 ? W / 2 : PAD + (i / (points.length - 1)) * (W - 2 * PAD);

    return (
        <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`Weight error for the last ${points.length} grinds, against a ±${TOLERANCE_G} gram tolerance band`}
            className="block h-14 w-full"
        >
            <title>Weight error per grind</title>
            {/* Tolerance band as a filled region, not two dashed rules: the
                question is "inside or outside", which is an area. */}
            <rect
                x={0}
                y={y(TOLERANCE_G)}
                width={W}
                height={Math.max(0, y(-TOLERANCE_G) - y(TOLERANCE_G))}
                className="fill-success/10"
            />
            <line x1={0} x2={W} y1={y(0)} y2={y(0)} className="stroke-success/50" strokeWidth={1} />
            {points.length > 1 && (
                <polyline
                    points={points.map((p, i) => `${x(i)},${y(p.error)}`).join(' ')}
                    fill="none"
                    className="stroke-muted-foreground/40"
                    strokeWidth={1}
                />
            )}
            {points.map((p, i) => (
                <circle
                    // biome-ignore lint/suspicious/noArrayIndexKey: reborn session ids can repeat; position disambiguates a static list
                    key={`${p.id}-${i}`}
                    cx={x(i)}
                    cy={y(p.error)}
                    r={3}
                    className={
                        Math.abs(p.error) < TOLERANCE_G
                            ? 'fill-muted-foreground'
                            : 'fill-destructive'
                    }
                >
                    <title>{`#${p.id}: ${p.error >= 0 ? '+' : ''}${p.error.toFixed(3)} g`}</title>
                </circle>
            ))}
        </svg>
    );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
    return (
        <div className="px-4 py-3 first:pl-0">
            <div className="text-muted-foreground text-xs">{label}</div>
            <div className="mt-1 font-medium font-mono text-lg tabular-nums">{value}</div>
            {hint && <div className="mt-0.5 text-muted-foreground text-xs">{hint}</div>}
        </div>
    );
}

function LatestGrind({ record }: { record: StoredRecord }) {
    const s = record.session;
    const mode = MODE_MAP[s.grind_mode] ?? 'WEIGHT';
    const grindTime = grindTimeSeconds(record.events);
    const activeSeconds = grindTime > 0 ? grindTime : s.total_time_ms / 1000;
    const onTarget = Math.abs(s.final_weight - s.target_weight) < TOLERANCE_G;

    return (
        <div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
                <span className="font-mono">#{s.session_id}</span>
                <span>{mode === 'WEIGHT' ? 'Weight' : 'Time'}</span>
                <span>{PROFILE_MAP[s.profile_id] ?? `P${s.profile_id}`}</span>
                {isEpochTimestamp(s.session_timestamp) && <span>{sessionStartLabel(s)}</span>}
            </div>

            <div className="mt-2 flex items-baseline gap-2">
                <span className="font-mono font-semibold text-5xl tabular-nums tracking-tight">
                    {s.final_weight.toFixed(2)}
                </span>
                <span className="text-muted-foreground text-xl">g</span>
            </div>

            <div className="mt-2 font-mono text-sm">
                <span className="text-muted-foreground">target {sessionTargetLabel(s)}</span>
                <span
                    className={cn(
                        'ml-2 font-medium',
                        mode === 'WEIGHT'
                            ? onTarget
                                ? 'text-success'
                                : 'text-destructive'
                            : 'text-muted-foreground',
                    )}
                >
                    {sessionErrorLabel(s)}
                </span>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
                <span className="font-mono tabular-nums">
                    {activeSeconds.toFixed(1)} s
                    <span className="ml-1.5 font-sans text-muted-foreground text-xs">grind</span>
                </span>
                <span className="font-mono tabular-nums">
                    {s.pulse_count}
                    <span className="ml-1.5 font-sans text-muted-foreground text-xs">
                        {s.pulse_count === 1 ? 'pulse' : 'pulses'}
                    </span>
                </span>
                <ResultBadge status={s.result_status} />
            </div>
        </div>
    );
}

export function Hero({ records }: { records: StoredRecord[] }) {
    const latest = records[records.length - 1];
    if (!latest) return null;

    const weightRecords = records.filter(
        (r) => (MODE_MAP[r.session.grind_mode] ?? 'WEIGHT') === 'WEIGHT',
    );
    const errors = weightRecords.map((r) => r.session.final_weight - r.session.target_weight);
    const within = errors.filter((e) => Math.abs(e) < TOLERANCE_G).length;
    const grindTimes = weightRecords.map((r) => grindTimeSeconds(r.events)).filter((t) => t > 0);
    const meanError = mean(errors);
    const sigma = stddev(errors);

    return (
        <div className="grid gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,20rem)_1fr]">
            <LatestGrind record={latest} />

            <div className="min-w-0">
                <div className="flex flex-wrap divide-x divide-border border-b pb-1">
                    <Kpi label="Grinds" value={String(records.length)} />
                    {errors.length > 0 && (
                        <>
                            <Kpi
                                label={`Within ±${TOLERANCE_G.toFixed(2)} g`}
                                value={`${((within / errors.length) * 100).toFixed(0)}%`}
                                hint={`${within} of ${errors.length}`}
                            />
                            <Kpi
                                label="Mean error"
                                value={`${meanError >= 0 ? '+' : ''}${meanError.toFixed(3)} g`}
                            />
                            <Kpi
                                label="Error σ"
                                value={Number.isNaN(sigma) ? 'n/a' : `${sigma.toFixed(3)} g`}
                            />
                            <Kpi
                                label="Avg grind"
                                value={
                                    grindTimes.length ? `${mean(grindTimes).toFixed(1)} s` : 'n/a'
                                }
                            />
                        </>
                    )}
                </div>

                {weightRecords.length >= 2 && (
                    <div className="mt-4">
                        <div className="mb-1 text-muted-foreground text-xs">
                            Error per session · ±{TOLERANCE_G.toFixed(2)} g band
                        </div>
                        <ErrorSparkline weightRecords={weightRecords} />
                    </div>
                )}
            </div>
        </div>
    );
}
