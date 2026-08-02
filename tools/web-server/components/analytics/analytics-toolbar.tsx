'use client';

// Data actions for the whole dashboard: pull from the grinder, and the
// local-store escape hatches. Destructive clearing goes through a dialog that
// says exactly what it does not touch.
import { Download, Plug, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { useAnalytics } from '@/components/analytics/analytics-provider';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { useGrinder } from '@/lib/client/use-grinder';

export function AnalyticsToolbar() {
    const { busy, pullData, exportJson, importJson, clearStoredData, records } = useAnalytics();
    const grinder = useGrinder();
    const importInput = useRef<HTMLInputElement>(null);
    const [confirmClear, setConfirmClear] = useState(false);

    return (
        <div className="mb-5 flex flex-wrap items-center gap-2">
            <Button disabled={busy || !grinder.supported} onClick={() => pullData()}>
                <Plug />
                Pull grinds
            </Button>
            <div className="flex-1" />
            <Button variant="ghost" size="sm" onClick={exportJson}>
                <Download />
                Export
            </Button>
            <Button variant="ghost" size="sm" onClick={() => importInput.current?.click()}>
                <Upload />
                Import
            </Button>
            <Button
                variant="ghost"
                size="sm"
                disabled={!records.length}
                onClick={() => setConfirmClear(true)}
            >
                <Trash2 />
                Clear
            </Button>

            <input
                ref={importInput}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) importJson(file);
                    e.target.value = '';
                }}
            />

            <ConfirmDialog
                open={confirmClear}
                onOpenChange={setConfirmClear}
                title="Delete local grinds?"
                description="Only this browser's copy — the grinder and your backup keep theirs."
                confirmLabel="Delete"
                destructive
                onConfirm={() => clearStoredData()}
            />
        </div>
    );
}
