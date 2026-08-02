'use client';

import { MetricTile, ResultBadge } from '@/components/ui';
import { grindTimeSeconds } from '@/lib/analytics/figures';
// Summary hero: the newest grind presented like the device's completion
// screen, fleet KPIs across every stored session, and the error sparkline.
import { mean, stddev } from '@/lib/analytics/frame';
import { sessionErrorLabel, sessionStartLabel, sessionTargetLabel } from '@/lib/analytics/labels';
import { isEpochTimestamp, type StoredRecord, TOLERANCE_G } from '@/lib/analytics/types';
import { MODE_MAP, PROFILE_MAP } from '@/lib/parser';

// Miniature of the multi-session "Error vs Session ID" chart: one point per
// weight-mode grind, tolerance guides in red, zero line in green. Points
// outside tolerance are red as well as outside the band (double encoding).
function ErrorSparkline({ weightRecords }: { weightRecords: StoredRecord[] }) {
    const W = 600;
    const H = 52;
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
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Weight error per session">
            <line
                x1={0}
                x2={W}
                y1={y(0)}
                y2={y(0)}
                stroke="#0ca30c"
                strokeWidth={1}
                opacity={0.5}
            />
            {[TOLERANCE_G, -TOLERANCE_G].map((tol) => (
                <line
                    key={tol}
                    x1={0}
                    x2={W}
                    y1={y(tol)}
                    y2={y(tol)}
                    stroke="#e66767"
                    strokeWidth={1}
                    strokeDasharray="4 4"
                    opacity={0.6}
                />
            ))}
            {points.length > 1 && (
                <polyline
                    points={points.map((p, i) => `${x(i)},${y(p.error)}`).join(' ')}
                    fill="none"
                    stroke="rgba(57,135,229,0.35)"
                    strokeWidth={1.5}
                />
            )}
            {points.map((p, i) => (
                <circle
                    // biome-ignore lint/suspicious/noArrayIndexKey: reborn session ids can repeat; position disambiguates a static list
                    key={`${p.id}-${i}`}
                    cx={x(i)}
                    cy={y(p.error)}
                    r={3.5}
                    fill={Math.abs(p.error) < TOLERANCE_G ? '#3987e5' : '#d03b3b'}
                >
                    <title>{`#${p.id}: ${p.error >= 0 ? '+' : ''}${p.error.toFixed(3)} g`}</title>
                </circle>
            ))}
        </svg>
    );
}

// Left hero panel: the newest grind, presented like the device's completion
// screen — big final weight, target and signed error.
function LatestPanel({ record }: { record: StoredRecord }) {
    const s = record.session;
    const mode = MODE_MAP[s.grind_mode] ?? 'WEIGHT';
    const grindTime = grindTimeSeconds(record.events);
    const activeSeconds = grindTime > 0 ? grindTime : s.total_time_ms / 1000;
    const errorClass =
        mode === 'WEIGHT'
            ? Math.abs(s.final_weight - s.target_weight) < TOLERANCE_G
                ? 'good'
                : 'bad'
            : '';

    return (
        <div className="hero-latest">
            <div className="session-line">
                <span>LATEST · #{s.session_id}</span>
                <span>{mode}</span>
                <span>{PROFILE_MAP[s.profile_id] ?? `P${s.profile_id}`}</span>
                {isEpochTimestamp(s.session_timestamp) && <span>{sessionStartLabel(s)}</span>}
            </div>
            <div className="hero-weight">
                {s.final_weight.toFixed(2)}
                <span className="unit"> g</span>
            </div>
            <div className="hero-target">
                target {sessionTargetLabel(s)} ·{' '}
                <span className={`hero-error ${errorClass}`}>{sessionErrorLabel(s)}</span>
            </div>
            <div className="hero-facts">
                <div>
                    <b>{activeSeconds.toFixed(1)} s</b>grind time
                </div>
                <div>
                    <b>{String(s.pulse_count)}</b>pulses
                </div>
                <div>
                    <b>
                        <ResultBadge status={s.result_status} />
                    </b>
                    result
                </div>
            </div>
        </div>
    );
}

// Right hero panel: KPIs across every stored session + the error sparkline.
function FleetPanel({ records }: { records: StoredRecord[] }) {
    const weightRecords = records.filter(
        (r) => (MODE_MAP[r.session.grind_mode] ?? 'WEIGHT') === 'WEIGHT',
    );

    const tiles = [<MetricTile key="sessions" label="Sessions" value={String(records.length)} />];
    if (weightRecords.length) {
        const errors = weightRecords.map((r) => r.session.final_weight - r.session.target_weight);
        const within = errors.filter((e) => Math.abs(e) < TOLERANCE_G).length;
        const grindTimes = weightRecords
            .map((r) => grindTimeSeconds(r.events))
            .filter((t) => t > 0);
        const meanError = mean(errors);
        const sigma = stddev(errors);
        tiles.push(
            <MetricTile
                key="within"
                label={`Within ±${TOLERANCE_G.toFixed(2)} g`}
                value={`${((within / errors.length) * 100).toFixed(0)}%`}
                delta={`${within}/${errors.length} grinds`}
            />,
            <MetricTile
                key="mean"
                label="Mean Error"
                value={`${meanError >= 0 ? '+' : ''}${meanError.toFixed(3)} g`}
            />,
            <MetricTile
                key="sigma"
                label="Error σ"
                value={Number.isNaN(sigma) ? 'n/a' : `${sigma.toFixed(3)} g`}
            />,
            <MetricTile
                key="time"
                label="Avg Grind Time"
                value={grindTimes.length ? `${mean(grindTimes).toFixed(1)} s` : 'n/a'}
            />,
        );
    }

    return (
        <div className="hero-fleet">
            <div className="kpi-row" style={{ margin: 0 }}>
                {tiles}
            </div>
            {weightRecords.length >= 2 && (
                <div className="sparkline-block">
                    <div className="spark-label">
                        error per session (g) · ±{TOLERANCE_G.toFixed(2)} band
                    </div>
                    <ErrorSparkline weightRecords={weightRecords} />
                </div>
            )}
        </div>
    );
}

export function Hero({ records }: { records: StoredRecord[] }) {
    const latest = records[records.length - 1];
    if (!latest) return null;
    return (
        <div className="hero">
            <LatestPanel record={latest} />
            <FleetPanel records={records} />
        </div>
    );
}
