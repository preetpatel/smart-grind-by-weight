'use client';

// Diagnostic report capture over BLE (React port of the flasher's
// diagnostics flow): triggers report generation, streams it from the debug
// characteristic, and offers copy/download.
import { Copy, Download, Stethoscope } from 'lucide-react';
import { useState } from 'react';
import { type StatusMessage, StatusRegion } from '@/components/status-region';
import { Button } from '@/components/ui/button';
import * as ble from '@/lib/client/ble';

const END_MARKER = '=== END OF REPORT ===';
const TIMEOUT_MS = 30000;

export function DiagnosticsPanel() {
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<StatusMessage | null>(null);
    const [report, setReport] = useState<string | null>(null);

    const getReport = async () => {
        let debugTx: BluetoothRemoteGATTCharacteristic | null = null;
        let onChunk: ((event: Event) => void) | null = null;

        // The report streams for up to 30s - hold the link so a concurrent
        // release() can't disconnect us partway through. Taken outside the
        // try so it pairs exactly with the finally below.
        ble.hold();
        setBusy(true);
        try {
            setStatus({ text: 'Connecting…', kind: 'info' });
            await ble.connect();
            setStatus({ text: 'Requesting report…', kind: 'info' });

            const debugService = await ble.getService(ble.UUIDS.DEBUG_SERVICE);
            const sysinfoService = await ble.getService(ble.UUIDS.SYSINFO_SERVICE);
            debugTx = await debugService.getCharacteristic(ble.UUIDS.DEBUG_TX);
            const trigger = await sysinfoService.getCharacteristic(ble.UUIDS.SYSINFO_DIAGNOSTICS);

            const chunks: string[] = [];
            let complete = false;

            // Try to stop notifications first (in case they're already active)
            try {
                await debugTx.stopNotifications();
                await new Promise((resolve) => setTimeout(resolve, 200));
            } catch {
                /* ignore if notifications weren't active */
            }

            await debugTx.startNotifications();
            onChunk = (event) => {
                const target = event.target as BluetoothRemoteGATTCharacteristic;
                if (!target.value) return;
                const chunk = new TextDecoder().decode(target.value);
                chunks.push(chunk);
                if (chunk.includes(END_MARKER)) complete = true;
            };
            debugTx.addEventListener('characteristicvaluechanged', onChunk);

            await trigger.writeValue(new Uint8Array([0x01]) as BufferSource);
            setStatus({ text: 'Generating…', kind: 'info' });

            const startTime = Date.now();
            while (!complete && Date.now() - startTime < TIMEOUT_MS) {
                await new Promise((resolve) => setTimeout(resolve, 100));
            }

            const fullReport = chunks.join('');
            if (complete) {
                setReport(fullReport);
                setStatus({ text: 'Report received.', kind: 'success' });
            } else {
                setStatus({
                    text: 'Timed out — showing the partial report.',
                    kind: 'error',
                });
                if (fullReport) setReport(fullReport);
            }
        } catch (error) {
            console.error('Diagnostic error:', error);
            setStatus({
                text: `Error: ${error instanceof Error ? error.message : error}`,
                kind: 'error',
            });
        } finally {
            // Leave the shared connection clean for the next flow.
            if (debugTx) {
                if (onChunk) debugTx.removeEventListener('characteristicvaluechanged', onChunk);
                try {
                    await debugTx.stopNotifications();
                } catch {
                    /* ignore cleanup errors */
                }
            }
            ble.releaseHold();
            setBusy(false);
        }
    };

    const copyReport = async () => {
        if (!report) return;
        try {
            await navigator.clipboard.writeText(report);
            const { toast } = await import('sonner');
            toast.success('Report copied');
        } catch {
            const { toast } = await import('sonner');
            toast.error('Couldn’t copy the report');
        }
    };

    const downloadReport = () => {
        if (!report) return;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
        const blob = new Blob([report], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `grinder-diagnostics-${timestamp}.txt`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    };

    return (
        <div>
            <Button disabled={busy} onClick={getReport}>
                <Stethoscope />
                {busy ? 'Reading…' : 'Get report'}
            </Button>

            <div className="mt-6 max-w-2xl">
                <StatusRegion status={status} />
            </div>

            {report !== null && (
                <div className="mt-2">
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                        <h2 className="font-medium text-base">Report</h2>
                        <div className="flex gap-1">
                            <Button variant="ghost" size="sm" onClick={copyReport}>
                                <Copy />
                                Copy
                            </Button>
                            <Button variant="ghost" size="sm" onClick={downloadReport}>
                                <Download />
                                Download
                            </Button>
                        </div>
                    </div>
                    <pre className="max-h-[32rem] overflow-auto rounded-2xl border bg-card px-4 py-3 font-mono text-muted-foreground text-xs whitespace-pre-wrap">
                        {report}
                    </pre>
                </div>
            )}
        </div>
    );
}
