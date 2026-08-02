'use client';

// The persistent place to look during a long device operation — an OTA flash,
// a full data pull, a cloud sync. Deliberately not a toast: these run for
// minutes and the user needs somewhere stable to watch. Toasts are reserved
// for short acknowledgements.
import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Progress } from '@/components/ui/progress';

export type StatusKind = 'info' | 'success' | 'error' | 'warning';

export interface StatusMessage {
    text: string;
    kind: StatusKind;
}

const PRESENTATION = {
    info: { variant: 'default', Icon: Info },
    success: { variant: 'success', Icon: CircleCheck },
    warning: { variant: 'caution', Icon: TriangleAlert },
    error: { variant: 'destructive', Icon: CircleAlert },
} as const;

export function StatusRegion({
    status,
    progress,
}: {
    status: StatusMessage | null;
    progress?: number | null;
}) {
    if (!status?.text && progress == null) return null;
    const { variant, Icon } = PRESENTATION[status?.kind ?? 'info'];

    return (
        <div className="mb-5 space-y-2">
            {status?.text && (
                <Alert variant={variant}>
                    <Icon />
                    <AlertDescription className="text-current">{status.text}</AlertDescription>
                </Alert>
            )}
            {progress != null && (
                <Progress value={Math.min(100, progress)} aria-label="Operation progress" />
            )}
        </div>
    );
}
