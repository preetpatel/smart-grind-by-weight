// Web Bluetooth client for the grinder's BLE data export service.
//
// Mirrors the export flow in tools/ble/grinder-ble.py: request the session
// file list, then request each session file individually, accumulating
// notification chunks until the status characteristic reports COMPLETE.
// UUIDs and command bytes must match src/config/bluetooth.h.

import { parseSessionFile, HEADER_SIZE } from './parser.js';

export const DEVICE_NAME = 'GrindByWeight';

const BLE_DATA_SERVICE_UUID = '22334455-6677-8899-aabb-ccddeeffffaa';
const BLE_DATA_CONTROL_CHAR_UUID = '33445566-7788-99aa-bbcc-ddeeffaabbcc';
const BLE_DATA_TRANSFER_CHAR_UUID = '44556677-8899-aabb-ccdd-eeffaabbccdd';
const BLE_DATA_STATUS_CHAR_UUID = '55667788-99aa-bbcc-ddee-ffaabbccddee';

// Requested at connect time so later milestones (device health) can read them
// over the same pairing without a new permission prompt.
const BLE_SYSINFO_SERVICE_UUID = '77889900-aabb-ccdd-eeff-112233445566';
const BLE_DEBUG_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';

const BLE_DATA_CMD_STOP_EXPORT = 0x11;
const BLE_DATA_CMD_GET_FILE_LIST = 0x14;
const BLE_DATA_CMD_REQUEST_FILE = 0x15;

const BLE_DATA_EXPORTING = 0x21;
const BLE_DATA_COMPLETE = 0x22;
const BLE_DATA_ERROR = 0x23;

const FILE_LIST_TIMEOUT_MS = 10000;
const FILE_TRANSFER_TIMEOUT_MS = 60000;

// BLE notification chunks can get dropped between the device and the browser
// (observed on Chrome/macOS as whole 512-byte chunks missing mid-stream,
// consistently starting ~20 chunks in). The device pairs every data chunk
// with a status notification, doubling the notification rate, so during file
// transfers the status subscription is dropped entirely and completion is
// detected from the expected file size in the session header instead. Each
// transfer is verified against that size and retried on any loss.
const FILE_TRANSFER_ATTEMPTS = 3;
const RETRY_SETTLE_DELAY_MS = 400;
// Data chunks arrive as acknowledged indications (~30-150ms apart), so a few
// seconds of silence means the link has genuinely degraded; failing fast and
// re-requesting beats politely waiting out the device's retry envelope. A
// device-side abort is reported through the status characteristic and fails
// the attempt immediately, without waiting for this timeout.
const CHUNK_INACTIVITY_TIMEOUT_MS = 4000;

export function isWebBluetoothSupported() {
    return 'bluetooth' in navigator;
}

export class GrinderDataClient {
    constructor() {
        this.device = null;
        this.server = null;
        this.controlChar = null;
        this.transferChar = null;
        this.statusChar = null;
        this._chunks = [];
        this._receiving = false;
        this._resolveReceive = null;
        this._rejectReceive = null;
        this._lastChunkSizes = [];
        this._lastExpectedBytes = null;
        this.onFileProgress = null; // (percent) => void, per-file transfer progress
    }

    get connected() {
        return !!(this.server && this.server.connected);
    }

    async connect() {
        this.device = await navigator.bluetooth.requestDevice({
            filters: [{ name: DEVICE_NAME }],
            optionalServices: [BLE_DATA_SERVICE_UUID, BLE_SYSINFO_SERVICE_UUID, BLE_DEBUG_SERVICE_UUID],
        });
        this.server = await this.device.gatt.connect();

        const dataService = await this.server.getPrimaryService(BLE_DATA_SERVICE_UUID);
        this.controlChar = await dataService.getCharacteristic(BLE_DATA_CONTROL_CHAR_UUID);
        this.transferChar = await dataService.getCharacteristic(BLE_DATA_TRANSFER_CHAR_UUID);
        this.statusChar = await dataService.getCharacteristic(BLE_DATA_STATUS_CHAR_UUID);

        await this.transferChar.startNotifications();
        this.transferChar.addEventListener('characteristicvaluechanged', (event) => {
            this._onTransferChunk(event.target.value);
        });

        await this.statusChar.startNotifications();
        this.statusChar.addEventListener('characteristicvaluechanged', (event) => {
            this._onStatusUpdate(event.target.value);
        });
    }

    disconnect() {
        if (this.device && this.device.gatt.connected) {
            this.device.gatt.disconnect();
        }
        this.device = null;
        this.server = null;
    }

    _onTransferChunk(value) {
        if (!this._receiving) return;
        this._chunks.push(new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)));
        this._chunkSizes.push(value.byteLength);
        this._receivedBytes += value.byteLength;
        this._bumpInactivityTimer();

        // File transfers self-complete on byte count: the first chunk carries
        // the session header, which states the total file size.
        if (this._sizeFromHeader && this._expectedBytes === null && this._chunks[0].byteLength >= 12) {
            const first = this._chunks[0];
            const view = new DataView(first.buffer, first.byteOffset, first.byteLength);
            this._expectedBytes = HEADER_SIZE + view.getUint32(8, true);
        }
        if (this._expectedBytes !== null) {
            if (this.onFileProgress) {
                this.onFileProgress(Math.min(100, (this._receivedBytes / this._expectedBytes) * 100));
            }
            if (this._receivedBytes >= this._expectedBytes && this._resolveReceive) {
                this._resolveReceive();
            }
        }
    }

    _bumpInactivityTimer() {
        if (!this._inactivityMs) return;
        clearTimeout(this._inactivityTimer);
        this._inactivityTimer = setTimeout(() => {
            if (this._rejectReceive) {
                this._rejectReceive(new Error(`transfer stalled: no chunk for ${this._inactivityMs} ms`));
            }
        }, this._inactivityMs);
    }

    _onStatusUpdate(value) {
        if (value.byteLength === 0) return;
        const status = value.getUint8(0);
        if (status === BLE_DATA_EXPORTING) {
            const percent = value.byteLength > 1 ? value.getUint8(1) : 0;
            if (percent > 0 && this.onFileProgress) this.onFileProgress(percent);
        } else if (status === BLE_DATA_COMPLETE) {
            if (this._resolveReceive) this._resolveReceive();
        } else if (status === BLE_DATA_ERROR) {
            if (this._rejectReceive) this._rejectReceive(new Error('Grinder reported an error during export'));
        }
    }

    // Arms chunk reception BEFORE the triggering command is written, matching
    // the Python tool's ordering to avoid dropping the first notification.
    // With sizeFromHeader, the receive resolves once the byte count from the
    // session header is reached and inactivity is treated as a stall; without
    // it, completion relies on the status characteristic's COMPLETE.
    _startReceive({ sizeFromHeader = false, inactivityMs = 0 } = {}) {
        this._chunks = [];
        this._chunkSizes = [];
        this._receivedBytes = 0;
        this._expectedBytes = null;
        this._sizeFromHeader = sizeFromHeader;
        this._inactivityMs = inactivityMs;
        this._receiving = true;
        return new Promise((resolve, reject) => {
            this._resolveReceive = resolve;
            this._rejectReceive = reject;
        });
    }

    async _finishReceive(receivePromise, timeoutMs, label) {
        let timeoutId;
        try {
            await Promise.race([
                receivePromise,
                new Promise((_, reject) => {
                    timeoutId = setTimeout(() => reject(new Error(`Timeout waiting for ${label}`)), timeoutMs);
                }),
            ]);
        } finally {
            clearTimeout(timeoutId);
            clearTimeout(this._inactivityTimer);
            this._receiving = false;
            this._resolveReceive = null;
            this._rejectReceive = null;
            this._lastChunkSizes = this._chunkSizes;
            this._lastExpectedBytes = this._expectedBytes;
        }
        return this._concatChunks();
    }

    _concatChunks() {
        const total = this._chunks.reduce((sum, c) => sum + c.byteLength, 0);
        const out = new Uint8Array(total);
        let offset = 0;
        for (const chunk of this._chunks) {
            out.set(chunk, offset);
            offset += chunk.byteLength;
        }
        this._chunks = [];
        return out.buffer;
    }

    // Returns the list of session IDs stored on the device.
    // Wire format: [session_count:4][session_id1:4][session_id2:4]...
    async getFileList() {
        const receive = this._startReceive(); // completes via status COMPLETE
        await this.controlChar.writeValue(new Uint8Array([BLE_DATA_CMD_GET_FILE_LIST]));
        const buffer = await this._finishReceive(receive, FILE_LIST_TIMEOUT_MS, 'file list');

        const view = new DataView(buffer);
        if (buffer.byteLength < 4) {
            throw new Error(`Invalid file list data (${buffer.byteLength} bytes)`);
        }
        const count = view.getUint32(0, true);
        const expectedBytes = 4 + count * 4;
        if (buffer.byteLength < expectedBytes) {
            throw new Error(`Truncated file list: expected ${expectedBytes} bytes for ${count} sessions, got ${buffer.byteLength}`);
        }
        const sessionIds = [];
        for (let i = 0; i < count; i++) {
            sessionIds.push(view.getUint32(4 + i * 4, true));
        }
        return sessionIds;
    }

    // Fetches one session file as a raw ArrayBuffer (single attempt).
    async requestFile(sessionId) {
        const command = new Uint8Array(5);
        command[0] = BLE_DATA_CMD_REQUEST_FILE;
        new DataView(command.buffer).setUint32(1, sessionId, true);

        const receive = this._startReceive({ sizeFromHeader: true, inactivityMs: CHUNK_INACTIVITY_TIMEOUT_MS });
        await this.controlChar.writeValue(command);
        return this._finishReceive(receive, FILE_TRANSFER_TIMEOUT_MS, `session file ${sessionId}`);
    }

    // Resets the device-side export state machine, e.g. before retrying after
    // a timeout mid-transfer. Best-effort.
    async stopExport() {
        try {
            await this.controlChar.writeValue(new Uint8Array([BLE_DATA_CMD_STOP_EXPORT]));
        } catch {
            // Ignore: the device may already be idle or briefly unreachable.
        }
    }

    _transferDiagnostics() {
        const sizes = this._lastChunkSizes || [];
        if (!sizes.length) return 'no chunks received';
        const total = sizes.reduce((sum, s) => sum + s, 0);
        const expected = this._lastExpectedBytes !== null ? ` of ${this._lastExpectedBytes} expected` : '';
        return `received ${total} bytes${expected} in ${sizes.length} chunks (${Math.min(...sizes)}-${Math.max(...sizes)} bytes/chunk)`;
    }

    // The session file header states its own size, so a transfer with dropped
    // notification chunks can be detected before parsing.
    static expectedFileSize(buffer) {
        if (buffer.byteLength < HEADER_SIZE) return null;
        const sessionSize = new DataView(buffer).getUint32(8, true);
        return HEADER_SIZE + sessionSize;
    }

    // Fetches, verifies and parses one session file, retrying on chunk loss.
    async pullSession(sessionId, onProgress = () => {}) {
        let lastError = null;
        for (let attempt = 1; attempt <= FILE_TRANSFER_ATTEMPTS; attempt++) {
            try {
                const buffer = await this.requestFile(sessionId);
                const expected = GrinderDataClient.expectedFileSize(buffer);
                if (expected !== null && buffer.byteLength !== expected) {
                    throw new Error(`incomplete transfer: got ${buffer.byteLength} of ${expected} bytes `
                        + `(${expected - buffer.byteLength} lost)`);
                }
                return parseSessionFile(buffer, sessionId);
            } catch (error) {
                lastError = error;
                if (attempt < FILE_TRANSFER_ATTEMPTS) {
                    onProgress({
                        stage: 'retry', sessionId,
                        message: `Session ${sessionId} attempt ${attempt} failed (${error.message}), retrying...`,
                    });
                    await this.stopExport();
                    await new Promise((resolve) => setTimeout(resolve, RETRY_SETTLE_DELAY_MS));
                }
            }
        }
        throw new Error(`${lastError.message} after ${FILE_TRANSFER_ATTEMPTS} attempts; ${this._transferDiagnostics()}`);
    }

    // Pulls and parses every session on the device.
    // onProgress receives { stage, sessionId, index, total, message }.
    // A session that fails to transfer or parse is reported in `errors` and
    // skipped, matching the Python tool's per-file resilience.
    async pullAllSessions(onProgress = () => {}) {
        onProgress({ stage: 'list', message: 'Requesting session file list...' });
        const sessionIds = await this.getFileList();
        onProgress({ stage: 'list-done', total: sessionIds.length, message: `Found ${sessionIds.length} session files` });

        const records = [];
        const errors = [];
        const pulledAt = new Date().toISOString();

        for (let i = 0; i < sessionIds.length; i++) {
            const sessionId = sessionIds[i];
            onProgress({
                stage: 'file', sessionId, index: i, total: sessionIds.length,
                message: `Pulling session ${sessionId} (${i + 1}/${sessionIds.length})...`,
            });
            try {
                const { session, events, measurements, warnings } = await this.pullSession(sessionId, onProgress);
                records.push({ session_id: sessionId, session, events, measurements, pulledAt });
                for (const warning of warnings) {
                    onProgress({ stage: 'warning', sessionId, message: warning });
                }
            } catch (error) {
                errors.push({ sessionId, message: error.message });
                onProgress({ stage: 'error', sessionId, message: `Session ${sessionId} failed: ${error.message}` });
            }
        }

        return { records, errors };
    }
}
