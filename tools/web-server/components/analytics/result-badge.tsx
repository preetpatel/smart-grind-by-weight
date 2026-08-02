import { StatusLabel, type Tone } from '@/components/status-dot';

// How a grind ended. MAX_PULSES and TIMEOUT sit next to each other in the same
// column, so they get separated hues; the label is always present, so colour
// is redundant encoding rather than the only signal.
const TONE: Record<string, Tone> = {
    COMPLETE: 'success',
    OVERSHOOT: 'caution',
    MAX_PULSES: 'serious',
    TIMEOUT: 'critical',
};

export function ResultBadge({ status }: { status: string }) {
    return <StatusLabel tone={TONE[status] ?? 'neutral'}>{status}</StatusLabel>;
}
