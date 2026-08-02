// State as a dot plus a word — never colour alone, and never a filled pill.
// At the density this dashboard runs at, a column of solid badges reads as
// noise; a dot lets the label do the talking.
import { cn } from '@/lib/utils';

export type Tone = 'success' | 'caution' | 'serious' | 'critical' | 'neutral';

const DOT: Record<Tone, string> = {
    success: 'bg-success',
    caution: 'bg-caution',
    serious: 'bg-serious',
    critical: 'bg-destructive',
    neutral: 'bg-muted-foreground',
};

const TEXT: Record<Tone, string> = {
    success: 'text-success',
    caution: 'text-caution',
    serious: 'text-serious',
    critical: 'text-destructive',
    neutral: 'text-muted-foreground',
};

export function StatusDot({ tone, className }: { tone: Tone; className?: string }) {
    return (
        <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', DOT[tone], className)} />
    );
}

export function StatusLabel({
    tone,
    children,
    className,
}: {
    tone: Tone;
    children: React.ReactNode;
    className?: string;
}) {
    return (
        <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap', className)}>
            <StatusDot tone={tone} />
            <span className={cn('font-mono text-xs', TEXT[tone])}>{children}</span>
        </span>
    );
}
