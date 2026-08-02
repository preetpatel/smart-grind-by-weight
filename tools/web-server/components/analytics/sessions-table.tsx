'use client';

// Session browser table: newest first, click a row to open its analysis.
import { useState } from 'react';
import { ResultBadge } from '@/components/ui';
import { sessionErrorLabel, sessionStartLabel, sessionTargetLabel } from '@/lib/analytics/labels';
import { type StoredRecord, TOLERANCE_G } from '@/lib/analytics/types';
import { MODE_MAP, PROFILE_MAP } from '@/lib/parser';

const TABLE_ROW_LIMIT = 25;

export function SessionsTable({
    records,
    selectedSha,
    onSelect,
}: {
    records: StoredRecord[];
    selectedSha: string | null;
    onSelect: (sha: string | null) => void;
}) {
    const [expanded, setExpanded] = useState(false);
    if (!records.length) return null;

    // Newest first; recent grinds are what gets scanned. KPIs, sparkline and
    // trends always compute over the full set regardless of this cap.
    const newestFirst = [...records].reverse();
    const visible = expanded ? newestFirst : newestFirst.slice(0, TABLE_ROW_LIMIT);

    return (
        <div>
            <h3>Grind Sessions</h3>
            <p className="table-hint">Click a session to open its full analysis below.</p>
            <div className="table-scroll">
                <table className="data-table">
                    <thead>
                        <tr>
                            {[
                                'ID',
                                'Started',
                                'Mode',
                                'Profile',
                                'Target',
                                'Final (g)',
                                'Error',
                                'Pulses',
                                'Result',
                                'Events',
                                'Samples',
                            ].map((h) => (
                                <th key={h}>{h}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {visible.map((record) => {
                            const s = record.session;
                            const isWeight = (MODE_MAP[s.grind_mode] ?? 'WEIGHT') === 'WEIGHT';
                            const withinTolerance =
                                Math.abs(s.final_weight - s.target_weight) < TOLERANCE_G;
                            return (
                                <tr
                                    key={record.sha256}
                                    className={record.sha256 === selectedSha ? 'selected' : ''}
                                    onClick={() =>
                                        onSelect(
                                            record.sha256 === selectedSha ? null : record.sha256,
                                        )
                                    }
                                >
                                    <td>#{s.session_id}</td>
                                    <td>{sessionStartLabel(s)}</td>
                                    <td>{MODE_MAP[s.grind_mode] ?? 'UNKNOWN'}</td>
                                    <td>{PROFILE_MAP[s.profile_id] ?? `P${s.profile_id}`}</td>
                                    <td>{sessionTargetLabel(s)}</td>
                                    <td>{s.final_weight.toFixed(2)}</td>
                                    <td
                                        className={
                                            isWeight
                                                ? withinTolerance
                                                    ? 'num-good'
                                                    : 'num-bad'
                                                : ''
                                        }
                                    >
                                        {sessionErrorLabel(s)}
                                    </td>
                                    <td>{String(s.pulse_count)}</td>
                                    <td>
                                        <ResultBadge status={s.result_status} />
                                    </td>
                                    <td>{String(record.events.length)}</td>
                                    <td>{String(record.measurements.length)}</td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
            {records.length > TABLE_ROW_LIMIT && (
                <button type="button" className="btn-ghost" onClick={() => setExpanded(!expanded)}>
                    {expanded
                        ? `Show latest ${TABLE_ROW_LIMIT} only`
                        : `Show all ${records.length} sessions`}
                </button>
            )}
        </div>
    );
}
