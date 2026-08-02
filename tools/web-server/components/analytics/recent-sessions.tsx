'use client';

// The last few grinds as rows, not a table: on the overview the question is
// "how did the recent ones go", which needs weight, error and outcome — not
// eleven columns.
import Link from 'next/link';
import { ResultBadge } from '@/components/analytics/result-badge';
import { sessionErrorLabel, sessionStartLabel, sessionTargetLabel } from '@/lib/analytics/labels';
import { type StoredRecord, TOLERANCE_G } from '@/lib/analytics/types';
import { MODE_MAP } from '@/lib/parser';
import { cn } from '@/lib/utils';

export function RecentSessions({
    records,
    limit = 8,
}: {
    records: StoredRecord[];
    limit?: number;
}) {
    const newestFirst = [...records].reverse().slice(0, limit);

    return (
        <div className="border-t">
            {newestFirst.map((record) => {
                const s = record.session;
                const isWeight = (MODE_MAP[s.grind_mode] ?? 'WEIGHT') === 'WEIGHT';
                const withinTolerance = Math.abs(s.final_weight - s.target_weight) < TOLERANCE_G;
                return (
                    <Link
                        key={record.sha256}
                        href={`/analytics/session/${record.sha256}`}
                        className="flex items-center gap-4 border-b py-2.5 pr-2 pl-1 text-sm hover:bg-accent/40"
                    >
                        <span className="w-16 shrink-0 font-mono text-muted-foreground text-xs tabular-nums">
                            #{s.session_id}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
                            {sessionStartLabel(s)}
                        </span>
                        <span className="w-20 shrink-0 text-right font-mono text-muted-foreground text-xs tabular-nums">
                            {sessionTargetLabel(s)}
                        </span>
                        <span className="w-20 shrink-0 text-right font-mono tabular-nums">
                            {s.final_weight.toFixed(2)} g
                        </span>
                        <span
                            className={cn(
                                'w-16 shrink-0 text-right font-mono text-xs tabular-nums',
                                isWeight
                                    ? withinTolerance
                                        ? 'text-success'
                                        : 'text-destructive'
                                    : 'text-muted-foreground',
                            )}
                        >
                            {sessionErrorLabel(s)}
                        </span>
                        <span className="w-28 shrink-0 text-right">
                            <ResultBadge status={s.result_status} />
                        </span>
                    </Link>
                );
            })}
        </div>
    );
}
