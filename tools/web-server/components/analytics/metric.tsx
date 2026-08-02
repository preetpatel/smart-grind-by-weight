'use client';

// A measurement and its label. Flat — no border, no fill — because a grid of
// twenty of these as boxes is a wall, whereas as text it is a table of facts.
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function MetricGrid({ children }: { children: ReactNode }) {
    return (
        <div className="my-4 grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-3 lg:grid-cols-5">
            {children}
        </div>
    );
}

export function MetricTile({
    label,
    value,
    delta,
    deltaClass = '',
}: {
    label: string;
    value: ReactNode;
    delta?: ReactNode;
    deltaClass?: '' | 'good' | 'bad';
}) {
    return (
        <div className="min-w-0">
            <div className="truncate text-muted-foreground text-xs">{label}</div>
            <div className="mt-1 font-medium font-mono text-lg tabular-nums">{value}</div>
            {delta != null && (
                <div
                    className={cn(
                        'mt-0.5 text-xs',
                        deltaClass === 'good'
                            ? 'text-success'
                            : deltaClass === 'bad'
                              ? 'text-destructive'
                              : 'text-muted-foreground',
                    )}
                >
                    {delta}
                </div>
            )}
        </div>
    );
}

// A short aside inside a view — "not enough data for this chart", "logging is
// off". Plain text with a tone, not a boxed alert: at this density an outlined
// panel for one sentence shouts louder than the charts around it.
export function Note({
    tone = 'muted',
    children,
}: {
    tone?: 'muted' | 'caution';
    children: ReactNode;
}) {
    return (
        <p
            className={cn(
                'my-4 text-sm',
                tone === 'caution' ? 'text-caution' : 'text-muted-foreground',
            )}
        >
            {children}
        </p>
    );
}
