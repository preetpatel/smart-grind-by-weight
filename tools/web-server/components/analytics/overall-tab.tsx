'use client';

// "Overall" analysis tab: metrics grid, per-phase event marker toggles, the
// weight + flow overview chart, and the raw data drill-down.
import { useMemo, useState } from 'react';
import { PlotlyChart } from '@/components/plotly-chart';
import { MetricTile } from '@/components/ui';
import {
    buildOverviewFigure,
    DEFAULT_HIDDEN_PHASES,
    filterForDisplay,
    grindTimeSeconds,
    PHASE_DESCRIPTIONS,
} from '@/lib/analytics/figures';
import { type StoredRecord, TOLERANCE_G } from '@/lib/analytics/types';
import { MODE_MAP, TERMINATION_REASON_MAP } from '@/lib/parser';

function MetricsGrid({ record, includeTaring }: { record: StoredRecord; includeTaring: boolean }) {
    const s = record.session;
    const mode = MODE_MAP[s.grind_mode] ?? 'WEIGHT';
    const measurements = filterForDisplay(record.measurements, includeTaring);
    const grindTime = grindTimeSeconds(record.events);
    const resolution = grindTime > 0 ? (measurements.length / grindTime).toFixed(1) : '0';

    if (mode === 'TIME') {
        const timeErrorS = s.time_error_ms / 1000;
        return (
            <div className="metric-grid">
                <MetricTile
                    label="Target Time (s)"
                    value={(s.target_time_ms / 1000).toFixed(2)}
                    delta={`${timeErrorS >= 0 ? '+' : ''}${timeErrorS.toFixed(2)} s`}
                    deltaClass={timeErrorS > 0 ? 'bad' : 'good'}
                />
                <MetricTile
                    label="Motor On Time (s)"
                    value={(s.total_motor_on_time_ms / 1000).toFixed(2)}
                />
                <MetricTile
                    label="Session Duration (s)"
                    value={(s.total_time_ms / 1000).toFixed(2)}
                />
                <MetricTile
                    label="Termination"
                    value={TERMINATION_REASON_MAP[s.termination_reason] ?? s.result_status}
                />
                <MetricTile label="Final Weight (g)" value={s.final_weight.toFixed(2)} />
                <MetricTile label="Data Resolution" value={`${resolution} meas/sec`} />
            </div>
        );
    }

    const error = s.final_weight - s.target_weight;
    const withinTolerance = Math.abs(error) < TOLERANCE_G;
    return (
        <div className="metric-grid">
            <MetricTile
                label="Target (g)"
                value={s.target_weight.toFixed(2)}
                delta={`${error >= 0 ? '+' : ''}${error.toFixed(2)} g`}
                deltaClass={withinTolerance ? 'good' : 'bad'}
            />
            <MetricTile label="Final (g)" value={s.final_weight.toFixed(2)} />
            <MetricTile label="Grind Time (s)" value={grindTime.toFixed(1)} />
            <MetricTile label="Result" value={s.result_status} />
            <MetricTile label="Pulse Count" value={String(s.pulse_count)} />
            <MetricTile label="Data Resolution" value={`${resolution} meas/sec`} />
        </div>
    );
}

function formatCell(value: unknown): string {
    return typeof value === 'number' && !Number.isInteger(value) ? value.toFixed(4) : String(value);
}

function RawTable<T extends object>({ items, columns }: { items: T[]; columns: (keyof T)[] }) {
    return (
        <div className="table-scroll tall">
            <table className="data-table">
                <thead>
                    <tr>
                        {columns.map((c) => (
                            <th key={String(c)}>{String(c)}</th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {items.map((item, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: rows are static per render
                        <tr key={i}>
                            {columns.map((c) => (
                                <td key={String(c)}>{formatCell(item[c])}</td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function RawDataSection({ record }: { record: StoredRecord }) {
    return (
        <details>
            <summary>Raw data for this session</summary>
            <div className="table-scroll">
                <table className="data-table">
                    <tbody>
                        {Object.entries(record.session).map(([key, value]) => (
                            <tr key={key}>
                                <th>{key}</th>
                                <td>{formatCell(value)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            {record.events.length > 0 && (
                <>
                    <h4>Events ({record.events.length})</h4>
                    <RawTable
                        items={record.events}
                        columns={[
                            'event_sequence_id',
                            'timestamp_ms',
                            'phase_name',
                            'duration_ms',
                            'start_weight',
                            'end_weight',
                            'motor_stop_target_weight',
                            'pulse_attempt_number',
                            'pulse_duration_ms',
                            'grind_latency_ms',
                            'settling_duration_ms',
                            'pulse_flow_rate',
                            'loop_count',
                            'event_flags',
                        ]}
                    />
                </>
            )}
            {record.measurements.length > 0 && (
                <>
                    <h4>Measurements ({record.measurements.length})</h4>
                    <RawTable
                        items={record.measurements}
                        columns={[
                            'sequence_id',
                            'timestamp_ms',
                            'weight_grams',
                            'weight_delta',
                            'flow_rate_g_per_s',
                            'motor_is_on',
                            'phase_name',
                            'motor_stop_target_weight',
                        ]}
                    />
                </>
            )}
        </details>
    );
}

export function OverallTab({
    record,
    includeTaring,
    smoothingMs,
}: {
    record: StoredRecord;
    includeTaring: boolean;
    smoothingMs: number;
}) {
    const [hiddenPhases, setHiddenPhases] = useState<ReadonlySet<string>>(
        () => new Set(DEFAULT_HIDDEN_PHASES),
    );

    const phases = useMemo(
        () =>
            [
                ...new Set(filterForDisplay(record.events, includeTaring).map((e) => e.phase_name)),
            ].sort(),
        [record, includeTaring],
    );

    const figure = useMemo(
        () =>
            buildOverviewFigure(record, {
                includeTaring,
                smoothingMs,
                visiblePhases: phases.filter((p) => !hiddenPhases.has(p)),
            }),
        [record, includeTaring, smoothingMs, phases, hiddenPhases],
    );

    return (
        <div>
            <MetricsGrid record={record} includeTaring={includeTaring} />
            <div className="controls-row">
                <span className="control">Event markers:</span>
                {phases.map((phase) => (
                    <label
                        key={phase}
                        className="control"
                        title={PHASE_DESCRIPTIONS[phase] ?? phase}
                    >
                        <input
                            type="checkbox"
                            checked={!hiddenPhases.has(phase)}
                            onChange={(e) => {
                                const next = new Set(hiddenPhases);
                                if (e.target.checked) next.delete(phase);
                                else next.add(phase);
                                setHiddenPhases(next);
                            }}
                        />{' '}
                        {phase}
                    </label>
                ))}
            </div>
            <PlotlyChart figure={figure} />
            <RawDataSection record={record} />
        </div>
    );
}
