'use client';

// A fact and what it means, as a row rather than a card: label on the left,
// value and consequence on the right, separated by a hairline. Rows that lead
// somewhere are links and reveal a chevron on hover.
import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function StatValue({ children, mono = false }: { children: ReactNode; mono?: boolean }) {
    return (
        <span className={cn('font-medium text-sm', mono && 'font-mono tabular-nums')}>
            {children}
        </span>
    );
}

export function StatRow({
    label,
    value,
    hint,
    hintTone = 'muted',
    href,
}: {
    label: string;
    value: ReactNode;
    hint?: ReactNode;
    hintTone?: 'muted' | 'caution' | 'success' | 'destructive';
    href?: string;
}) {
    const tone = {
        muted: 'text-muted-foreground',
        caution: 'text-caution',
        success: 'text-success',
        destructive: 'text-destructive',
    }[hintTone];

    const body = (
        <>
            <span className="text-muted-foreground text-sm">{label}</span>
            <span className="flex min-w-0 items-baseline gap-x-3 gap-y-0.5 justify-self-end text-right max-sm:flex-col max-sm:items-end">
                {value}
                {hint && <span className={cn('text-xs', tone)}>{hint}</span>}
            </span>
            <ChevronRight
                className={cn(
                    'size-4 text-muted-foreground transition-opacity',
                    href ? 'opacity-0 group-hover:opacity-100' : 'invisible',
                )}
            />
        </>
    );

    const className =
        'group grid grid-cols-[1fr_auto_1rem] items-center gap-3 border-b py-3 text-left';

    if (!href) return <div className={className}>{body}</div>;
    return (
        <Link href={href} className={cn(className, 'hover:bg-accent/40')}>
            {body}
        </Link>
    );
}
