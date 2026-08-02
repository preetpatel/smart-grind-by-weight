'use client';

// Diagnostic report capture over BLE (React port of the flasher's
// diagnostics flow): triggers report generation, streams it from the debug
// characteristic, and offers copy/download.
import { useState } from 'react';
import { StatusBox, type StatusMessage } from '@/components/ui';
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
            setStatus({ text: 'Connecting to device...', kind: 'info' });
            await ble.connect();
            setStatus({ text: 'Connected. Requesting diagnostic report...', kind: 'info' });

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
            setStatus({ text: 'Generating report...', kind: 'info' });

            const startTime = Date.now();
            while (!complete && Date.now() - startTime < TIMEOUT_MS) {
                await new Promise((resolve) => setTimeout(resolve, 100));
            }

            const fullReport = chunks.join('');
            if (complete) {
                setReport(fullReport);
                setStatus({ text: '✓ Diagnostic report generated successfully!', kind: 'success' });
            } else {
                setStatus({
                    text: 'Report generation timed out. Partial report received.',
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
            setStatus({ text: '✓ Report copied to clipboard!', kind: 'success' });
        } catch {
            setStatus({ text: 'Failed to copy report.', kind: 'error' });
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
        setStatus({ text: '✓ Report downloaded!', kind: 'success' });
    };

    return (
        <>
            <div className="form-stack">
                <h2>Diagnostic report</h2>
                <p className="lede-line">
                    Pulls the device&apos;s full self-test report — attach it to GitHub issues when
                    something misbehaves.
                </p>

                <button
                    type="button"
                    className="btn btn-accent"
                    disabled={busy}
                    onClick={getReport}
                >
                    Connect &amp; Get Diagnostics
                </button>
                <StatusBox status={status} />
            </div>

            {report !== null && (
                <div>
                    <h4>Report</h4>
                    <textarea id="diagnosticsReport" readOnly value={report} />
                    <div className="btn-row">
                        <button type="button" className="btn-ghost" onClick={copyReport}>
                            Copy to Clipboard
                        </button>
                        <button type="button" className="btn-ghost" onClick={downloadReport}>
                            Download Report
                        </button>
                    </div>
                </div>
            )}
        </>
    );
}
