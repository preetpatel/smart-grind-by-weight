// Web Bluetooth client for the grinder's BLE data export service.
//
// Mirrors the export flow in tools/ble/grinder-ble.py: request the session
// file list, then request each session file individually, accumulating
// notification chunks until the status characteristic reports COMPLETE.
// UUIDs and command bytes must match src/config/bluetooth.h.

import { parseSessionFile } from './parser.js';

export const DEVICE_NAME = 'GrindByWeight';

const BLE_DATA_SERVICE_UUID = '22334455-6677-8899-aabb-ccddeeffffaa';
const BLE_DATA_CONTROL_CHAR_UUID = '33445566-7788-99aa-bbcc-ddeeffaabbcc';
const BLE_DATA_TRANSFER_CHAR_UUID = '44556677-8899-aabb-ccdd-eeffaabbccdd';
const BLE_DATA_STATUS_CHAR_UUID = '55667788-99aa-bbcc-ddee-ffaabbccddee';

// Requested at connect time so later milestones (device health) can read them
// over the same pairing without a new permission prompt.
const BLE_SYSINFO_SERVICE_UUID = '77889900-aabb-ccdd-eeff-112233445566';
const BLE_DEBUG_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';

const BLE_DATA_CMD_GET_FILE_LIST = 0x14;
const BLE_DATA_CMD_REQUEST_FILE = 0x15;

const BLE_DATA_EXPORTING = 0x21;
const BLE_DATA_COMPLETE = 0x22;
const BLE_DATA_ERROR = 0x23;

const FILE_LIST_TIMEOUT_MS = 10000;
const FILE_TRANSFER_TIMEOUT_MS = 30000;

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
        this.onFileProgress = null; // (percent) => void, per-file device-side progress
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
    _startReceive() {
        this._chunks = [];
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
            this._receiving = false;
            this._resolveReceive = null;
            this._rejectReceive = null;
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
        const receive = this._startReceive();
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

    // Fetches one session file as a raw ArrayBuffer.
    async requestFile(sessionId) {
        const command = new Uint8Array(5);
        command[0] = BLE_DATA_CMD_REQUEST_FILE;
        new DataView(command.buffer).setUint32(1, sessionId, true);

        const receive = this._startReceive();
        await this.controlChar.writeValue(command);
        return this._finishReceive(receive, FILE_TRANSFER_TIMEOUT_MS, `session file ${sessionId}`);
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
                const buffer = await this.requestFile(sessionId);
                const { session, events, measurements, warnings } = parseSessionFile(buffer, sessionId);
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
