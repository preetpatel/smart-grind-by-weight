// Web Bluetooth client for the grinder's BLE data export service (TypeScript
// port of the flasher's ble-data.js).
//
// Mirrors the export flow in tools/ble/grinder-ble.py: request the session
// file list, then request each session file individually, accumulating
// notification chunks until the byte count from the session header is
// reached. UUIDs and command bytes must match src/config/bluetooth.h.

import type { DeviceReports, StoredRecord } from '@/lib/analytics/types';
import { HEADER_SIZE, parseSessionFile } from '@/lib/parser';
import * as ble from './ble';

const DIAGNOSTICS_TIMEOUT_MS = 30000;
const DIAGNOSTICS_END_MARKER = '=== END OF REPORT ===';

const CMD_STOP_EXPORT = 0x11;
const CMD_GET_FILE_LIST = 0x14;
const CMD_REQUEST_FILE = 0x15;

const STATUS_EXPORTING = 0x21;
const STATUS_COMPLETE = 0x22;
const STATUS_ERROR = 0x23;

const FILE_LIST_TIMEOUT_MS = 10000;
const FILE_TRANSFER_TIMEOUT_MS = 60000;

// BLE notification chunks can get dropped between the device and the browser
// (observed on Chrome/macOS as whole 512-byte chunks missing mid-stream).
// Each transfer is verified against the expected size from the session header
// and retried on any loss.
const FILE_TRANSFER_ATTEMPTS = 3;
const RETRY_SETTLE_DELAY_MS = 400;
// Data chunks arrive as acknowledged indications (~30-150ms apart), so a few
// seconds of silence means the link has genuinely degraded; failing fast and
// re-requesting beats politely waiting out the device's retry envelope.
const CHUNK_INACTIVITY_TIMEOUT_MS = 4000;

export interface PullProgress {
    stage: 'list' | 'list-done' | 'file' | 'retry' | 'warning' | 'error' | 'health';
    sessionId?: number;
    index?: number;
    total?: number;
    message: string;
}

export interface PullResult {
    records: StoredRecord[];
    errors: Array<{ sessionId: number; message: string }>;
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class GrinderDataClient {
    private controlChar: BluetoothRemoteGATTCharacteristic | null = null;
    private transferChar: BluetoothRemoteGATTCharacteristic | null = null;
    private statusChar: BluetoothRemoteGATTCharacteristic | null = null;

    private chunks: Uint8Array[] = [];
    private chunkSizes: number[] = [];
    private receivedBytes = 0;
    private expectedBytes: number | null = null;
    private sizeFromHeader = false;
    private inactivityMs = 0;
    private inactivityTimer: ReturnType<typeof setTimeout> | undefined;
    private receiving = false;
    private resolveReceive: (() => void) | null = null;
    private rejectReceive: ((error: Error) => void) | null = null;
    private lastChunkSizes: number[] = [];
    private lastExpectedBytes: number | null = null;
    private onTransferEvent: ((event: Event) => void) | null = null;
    private onStatusEvent: ((event: Event) => void) | null = null;

    onFileProgress: ((percent: number) => void) | null = null;

    // Uses the page-wide shared session (one chooser + one connection shared
    // with the update/WiFi/diagnostics flows). Pulling every session can run
    // for minutes - hold the link so a concurrent release() cannot disconnect
    // us mid-export. Released in disconnect().
    async connect(): Promise<void> {
        await ble.connect({ interactive: true });
        ble.hold();

        const dataService = await ble.getService(ble.UUIDS.DATA_SERVICE);
        this.controlChar = await dataService.getCharacteristic(ble.UUIDS.DATA_CONTROL);
        this.transferChar = await dataService.getCharacteristic(ble.UUIDS.DATA_TRANSFER);
        this.statusChar = await dataService.getCharacteristic(ble.UUIDS.DATA_STATUS);

        // On a shared connection the characteristic objects survive between
        // pulls, so keep handler references and remove them on disconnect —
        // a leftover handler would double-count chunks on the next pull.
        this.onTransferEvent = (event) => {
            const target = event.target as BluetoothRemoteGATTCharacteristic;
            if (target.value) this.onTransferChunk(target.value);
        };
        this.onStatusEvent = (event) => {
            const target = event.target as BluetoothRemoteGATTCharacteristic;
            if (target.value) this.onStatusUpdate(target.value);
        };

        await this.transferChar.startNotifications();
        this.transferChar.addEventListener('characteristicvaluechanged', this.onTransferEvent);

        await this.statusChar.startNotifications();
        this.statusChar.addEventListener('characteristicvaluechanged', this.onStatusEvent);
    }

    disconnect(): void {
        if (this.transferChar && this.onTransferEvent) {
            this.transferChar.removeEventListener(
                'characteristicvaluechanged',
                this.onTransferEvent,
            );
        }
        if (this.statusChar && this.onStatusEvent) {
            this.statusChar.removeEventListener('characteristicvaluechanged', this.onStatusEvent);
        }
        // Leave the shared connection up for other flows; it self-releases
        // after a short idle window once our hold is dropped.
        ble.releaseHold();
        this.controlChar = null;
        this.transferChar = null;
        this.statusChar = null;
    }

    private onTransferChunk(value: DataView): void {
        if (!this.receiving) return;
        this.chunks.push(
            new Uint8Array(
                value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
            ),
        );
        this.chunkSizes.push(value.byteLength);
        this.receivedBytes += value.byteLength;
        this.bumpInactivityTimer();

        // File transfers self-complete on byte count: the first chunk carries
        // the session header, which states the total file size.
        const first = this.chunks[0];
        if (this.sizeFromHeader && this.expectedBytes === null && first && first.byteLength >= 12) {
            const view = new DataView(first.buffer, first.byteOffset, first.byteLength);
            this.expectedBytes = HEADER_SIZE + view.getUint32(8, true);
        }
        if (this.expectedBytes !== null) {
            this.onFileProgress?.(Math.min(100, (this.receivedBytes / this.expectedBytes) * 100));
            if (this.receivedBytes >= this.expectedBytes) {
                this.resolveReceive?.();
            }
        }
    }

    private bumpInactivityTimer(): void {
        if (!this.inactivityMs) return;
        clearTimeout(this.inactivityTimer);
        this.inactivityTimer = setTimeout(() => {
            this.rejectReceive?.(
                new Error(`transfer stalled: no chunk for ${this.inactivityMs} ms`),
            );
        }, this.inactivityMs);
    }

    private onStatusUpdate(value: DataView): void {
        if (value.byteLength === 0) return;
        const status = value.getUint8(0);
        if (status === STATUS_EXPORTING) {
            const percent = value.byteLength > 1 ? value.getUint8(1) : 0;
            if (percent > 0) this.onFileProgress?.(percent);
        } else if (status === STATUS_COMPLETE) {
            this.resolveReceive?.();
        } else if (status === STATUS_ERROR) {
            this.rejectReceive?.(new Error('Grinder reported an error during export'));
        }
    }

    // Arms chunk reception BEFORE the triggering command is written, matching
    // the Python tool's ordering to avoid dropping the first notification.
    private startReceive({ sizeFromHeader = false, inactivityMs = 0 } = {}): Promise<void> {
        this.chunks = [];
        this.chunkSizes = [];
        this.receivedBytes = 0;
        this.expectedBytes = null;
        this.sizeFromHeader = sizeFromHeader;
        this.inactivityMs = inactivityMs;
        this.receiving = true;
        return new Promise<void>((resolve, reject) => {
            this.resolveReceive = resolve;
            this.rejectReceive = reject;
        });
    }

    private async finishReceive(
        receivePromise: Promise<void>,
        timeoutMs: number,
        label: string,
    ): Promise<ArrayBuffer> {
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                receivePromise,
                new Promise<never>((_, reject) => {
                    timeoutId = setTimeout(
                        () => reject(new Error(`Timeout waiting for ${label}`)),
                        timeoutMs,
                    );
                }),
            ]);
        } finally {
            clearTimeout(timeoutId);
            clearTimeout(this.inactivityTimer);
            this.receiving = false;
            this.resolveReceive = null;
            this.rejectReceive = null;
            this.lastChunkSizes = this.chunkSizes;
            this.lastExpectedBytes = this.expectedBytes;
        }
        return this.concatChunks();
    }

    private concatChunks(): ArrayBuffer {
        const total = this.chunks.reduce((sum, c) => sum + c.byteLength, 0);
        const out = new Uint8Array(total);
        let offset = 0;
        for (const chunk of this.chunks) {
            out.set(chunk, offset);
            offset += chunk.byteLength;
        }
        this.chunks = [];
        return out.buffer;
    }

    // Returns the list of session IDs stored on the device.
    // Wire format: [session_count:4][session_id1:4][session_id2:4]...
    async getFileList(): Promise<number[]> {
        if (!this.controlChar) throw new Error('Not connected');
        const receive = this.startReceive(); // completes via status COMPLETE
        await this.controlChar.writeValue(new Uint8Array([CMD_GET_FILE_LIST]));
        const buffer = await this.finishReceive(receive, FILE_LIST_TIMEOUT_MS, 'file list');

        const view = new DataView(buffer);
        if (buffer.byteLength < 4) {
            throw new Error(`Invalid file list data (${buffer.byteLength} bytes)`);
        }
        const count = view.getUint32(0, true);
        const expectedBytes = 4 + count * 4;
        if (buffer.byteLength < expectedBytes) {
            throw new Error(
                `Truncated file list: expected ${expectedBytes} bytes for ${count} sessions, got ${buffer.byteLength}`,
            );
        }
        const sessionIds: number[] = [];
        for (let i = 0; i < count; i++) {
            sessionIds.push(view.getUint32(4 + i * 4, true));
        }
        return sessionIds;
    }

    // Fetches one session file as a raw ArrayBuffer (single attempt).
    private async requestFile(sessionId: number): Promise<ArrayBuffer> {
        if (!this.controlChar) throw new Error('Not connected');
        const command = new Uint8Array(5);
        command[0] = CMD_REQUEST_FILE;
        new DataView(command.buffer).setUint32(1, sessionId, true);

        const receive = this.startReceive({
            sizeFromHeader: true,
            inactivityMs: CHUNK_INACTIVITY_TIMEOUT_MS,
        });
        await this.controlChar.writeValue(command);
        return this.finishReceive(receive, FILE_TRANSFER_TIMEOUT_MS, `session file ${sessionId}`);
    }

    // Resets the device-side export state machine, e.g. before retrying after
    // a timeout mid-transfer. Best-effort.
    async stopExport(): Promise<void> {
        try {
            await this.controlChar?.writeValue(new Uint8Array([CMD_STOP_EXPORT]));
        } catch {
            // Ignore: the device may already be idle or briefly unreachable.
        }
    }

    private transferDiagnostics(): string {
        const sizes = this.lastChunkSizes;
        if (!sizes.length) return 'no chunks received';
        const total = sizes.reduce((sum, s) => sum + s, 0);
        const expected =
            this.lastExpectedBytes !== null ? ` of ${this.lastExpectedBytes} expected` : '';
        return `received ${total} bytes${expected} in ${sizes.length} chunks (${Math.min(...sizes)}-${Math.max(...sizes)} bytes/chunk)`;
    }

    // The session file header states its own size, so a transfer with dropped
    // notification chunks can be detected before parsing.
    static expectedFileSize(buffer: ArrayBuffer): number | null {
        if (buffer.byteLength < HEADER_SIZE) return null;
        const sessionSize = new DataView(buffer).getUint32(8, true);
        return HEADER_SIZE + sessionSize;
    }

    // Fetches, verifies and parses one session file, retrying on chunk loss.
    // The verbatim bytes ride along as `raw`: the cloud backfill must upload
    // exactly what the device holds so content hashes match a later upload
    // from the device itself.
    async pullSession(
        sessionId: number,
        onProgress: (progress: PullProgress) => void = () => {},
    ): Promise<StoredRecord> {
        let lastError: Error | null = null;
        for (let attempt = 1; attempt <= FILE_TRANSFER_ATTEMPTS; attempt++) {
            try {
                const buffer = await this.requestFile(sessionId);
                const expected = GrinderDataClient.expectedFileSize(buffer);
                if (expected !== null && buffer.byteLength !== expected) {
                    throw new Error(
                        `incomplete transfer: got ${buffer.byteLength} of ${expected} bytes (${expected - buffer.byteLength} lost)`,
                    );
                }
                const parsed = parseSessionFile(buffer, sessionId);
                for (const warning of parsed.warnings) {
                    onProgress({ stage: 'warning', sessionId, message: warning });
                }
                return {
                    sha256: await sha256Hex(buffer),
                    session_id: sessionId,
                    session: parsed.session,
                    events: parsed.events,
                    measurements: parsed.measurements,
                    raw: new Uint8Array(buffer),
                    pulledAt: new Date().toISOString(),
                    source: 'ble',
                };
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                if (attempt < FILE_TRANSFER_ATTEMPTS) {
                    onProgress({
                        stage: 'retry',
                        sessionId,
                        message: `Grind #${sessionId} failed (${lastError.message}) — retrying…`,
                    });
                    await this.stopExport();
                    await new Promise((resolve) => setTimeout(resolve, RETRY_SETTLE_DELAY_MS));
                }
            }
        }
        throw new Error(
            `${lastError?.message} after ${FILE_TRANSFER_ATTEMPTS} attempts; ${this.transferDiagnostics()}`,
        );
    }

    // Reads the four system-info characteristics (JSON payloads) into the same
    // shape the Python tool stores.
    async getSystemInfo(): Promise<NonNullable<DeviceReports['system_info']>> {
        const service = await ble.getService(ble.UUIDS.SYSINFO_SERVICE);
        const read = async (uuid: string): Promise<Record<string, unknown>> => {
            const characteristic = await service.getCharacteristic(uuid);
            const value = await characteristic.readValue();
            return JSON.parse(new TextDecoder().decode(value)) as Record<string, unknown>;
        };
        return {
            system: await read(ble.UUIDS.SYSINFO_SYSTEM),
            performance: await read(ble.UUIDS.SYSINFO_PERFORMANCE),
            hardware: await read(ble.UUIDS.SYSINFO_HARDWARE),
            sessions: await read(ble.UUIDS.SYSINFO_SESSIONS),
        };
    }

    // Triggers diagnostic report generation and streams it from the debug
    // characteristic until the end marker.
    async getDiagnosticReport(): Promise<string> {
        const debugService = await ble.getService(ble.UUIDS.DEBUG_SERVICE);
        const sysinfoService = await ble.getService(ble.UUIDS.SYSINFO_SERVICE);
        const debugTx = await debugService.getCharacteristic(ble.UUIDS.DEBUG_TX);
        const trigger = await sysinfoService.getCharacteristic(ble.UUIDS.SYSINFO_DIAGNOSTICS);

        const chunks: string[] = [];
        let resolveDone: () => void = () => {};
        const done = new Promise<void>((resolve) => {
            resolveDone = resolve;
        });
        const onChunk = (event: Event) => {
            const target = event.target as BluetoothRemoteGATTCharacteristic;
            if (!target.value) return;
            const chunk = new TextDecoder().decode(target.value);
            chunks.push(chunk);
            if (chunk.includes(DIAGNOSTICS_END_MARKER)) resolveDone();
        };

        await debugTx.startNotifications();
        debugTx.addEventListener('characteristicvaluechanged', onChunk);
        try {
            await trigger.writeValue(new Uint8Array([0x01]));
            let timeoutId: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([
                done,
                new Promise<void>((resolve) => {
                    timeoutId = setTimeout(resolve, DIAGNOSTICS_TIMEOUT_MS);
                }),
            ]);
            clearTimeout(timeoutId);
        } finally {
            debugTx.removeEventListener('characteristicvaluechanged', onChunk);
            try {
                await debugTx.stopNotifications();
            } catch {
                // Best-effort cleanup.
            }
        }
        return chunks.join('');
    }

    // Captures the full device health snapshot; failures leave the matching
    // field null rather than failing the pull.
    async captureDeviceHealth(
        onProgress: (progress: PullProgress) => void = () => {},
    ): Promise<DeviceReports | null> {
        let systemInfo: DeviceReports['system_info'] = null;
        let diagnostics: string | null = null;
        try {
            onProgress({ stage: 'health', message: 'Reading system info…' });
            systemInfo = await this.getSystemInfo();
        } catch (error) {
            onProgress({
                stage: 'warning',
                message: `System info unavailable: ${error instanceof Error ? error.message : error}`,
            });
        }
        try {
            onProgress({ stage: 'health', message: 'Capturing diagnostics…' });
            diagnostics = await this.getDiagnosticReport();
            if (diagnostics && !diagnostics.includes(DIAGNOSTICS_END_MARKER)) {
                onProgress({
                    stage: 'warning',
                    message: 'Diagnostics timed out; keeping what arrived',
                });
            }
        } catch (error) {
            onProgress({
                stage: 'warning',
                message: `Diagnostics unavailable: ${error instanceof Error ? error.message : error}`,
            });
        }
        if (!systemInfo && !diagnostics) return null;
        return {
            system_info: systemInfo,
            diagnostics: diagnostics || null,
            captured_at: new Date().toISOString(),
        };
    }

    // Pulls and parses every session on the device. A session that fails to
    // transfer or parse is reported in `errors` and skipped, matching the
    // Python tool's per-file resilience.
    async pullAllSessions(
        onProgress: (progress: PullProgress) => void = () => {},
    ): Promise<PullResult> {
        onProgress({ stage: 'list', message: 'Listing grinds…' });
        const sessionIds = await this.getFileList();
        onProgress({
            stage: 'list-done',
            total: sessionIds.length,
            message: `${sessionIds.length} grinds to pull`,
        });

        const records: StoredRecord[] = [];
        const errors: Array<{ sessionId: number; message: string }> = [];

        for (let i = 0; i < sessionIds.length; i++) {
            const sessionId = sessionIds[i];
            if (sessionId === undefined) continue;
            onProgress({
                stage: 'file',
                sessionId,
                index: i,
                total: sessionIds.length,
                message: `Pulling grind ${i + 1} of ${sessionIds.length}…`,
            });
            try {
                records.push(await this.pullSession(sessionId, onProgress));
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                errors.push({ sessionId, message });
                onProgress({
                    stage: 'error',
                    sessionId,
                    message: `Grind #${sessionId} failed: ${message}`,
                });
            }
        }

        return { records, errors };
    }
}
