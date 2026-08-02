// BLE OTA update flow (TypeScript port of the flasher.js upload path).
// Protocol constants mirror src/config/bluetooth.h and the Python tool.
import * as ble from './ble';

const CMD_START = 0x01;
const CMD_END = 0x03;
const CMD_ABORT = 0x04;

const STATUS_RECEIVING = 0x02;
const STATUS_SUCCESS = 0x03;
const STATUS_ERROR = 0x04;

const CHUNK_SIZE = 512; // Browser BLE limit - cannot exceed 512 bytes per write

// A dropped link mid-upload is recoverable: the device aborts its half of the
// OTA the moment the link drops and resumes advertising, so the transfer can
// restart from the first chunk (the protocol has no resume-from-offset).
const MAX_TRANSFER_ATTEMPTS = 3;
const RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 2000;

export interface OtaCallbacks {
    onStatus: (message: string, kind: 'info' | 'success' | 'error') => void;
    onProgress: (percent: number | null) => void;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// zlib-compatible CRC-32; sent with the END command so the device can verify
// the patch as staged in its flash before the 30-90s apply cycle.
export function crc32(data: Uint8Array): number {
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
        crc ^= data[i] ?? 0;
        for (let bit = 0; bit < 8; bit++) {
            crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

async function downloadFirmware(url: string, callbacks: OtaCallbacks): Promise<Uint8Array> {
    callbacks.onStatus(`Downloading firmware...`, 'info');
    callbacks.onProgress(0);

    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const contentLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
    if (!response.body) throw new Error('No response body');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;

    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        receivedBytes += value.length;
        if (contentLength) {
            callbacks.onProgress((receivedBytes / contentLength) * 100);
        }
    }

    const firmware = new Uint8Array(receivedBytes);
    let offset = 0;
    for (const chunk of chunks) {
        firmware.set(chunk, offset);
        offset += chunk.length;
    }
    callbacks.onStatus(`Downloaded ${Math.round(firmware.length / 1024)}KB firmware`, 'success');
    return firmware;
}

// Verify a downloaded OTA binary against the release's SHA-256 manifest
// (published alongside the assets since v1.6.0-rc.6; older releases skip).
// Throws on mismatch so the flash never starts with corrupt bytes.
async function verifyFirmwareDownload(
    firmwareUrl: string,
    data: Uint8Array,
    callbacks: OtaCallbacks,
): Promise<void> {
    if (!firmwareUrl.endsWith('-web-ota.bin')) return;
    const manifestUrl = firmwareUrl.replace(/-web-ota\.bin$/, '.sha256');
    let manifestText: string;
    try {
        const resp = await fetch(manifestUrl);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        manifestText = await resp.text();
    } catch {
        console.log('No SHA-256 manifest for this release - skipping download verification');
        return;
    }
    const fileName = firmwareUrl.split('/').pop() ?? '';
    const line = manifestText.split('\n').find((l) => l.trim().endsWith(fileName));
    if (!line) {
        console.warn(`SHA-256 manifest has no entry for ${fileName} - skipping verification`);
        return;
    }
    const expected = line.trim().split(/\s+/)[0]?.toLowerCase();
    const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
    const actual = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    if (actual !== expected) {
        throw new Error('Downloaded firmware fails its SHA-256 check - try again');
    }
    callbacks.onStatus('Download verified against release SHA-256 manifest', 'info');
}

// After an apply that ended without a definitive status (link dropped during
// the reboot), poll until the device comes back and compare the running
// version. Returns true/false, or null if the device never reappeared.
async function verifyVersionAfterReboot(
    expectedVersion: string | null,
    timeoutMs = 90000,
): Promise<boolean | null> {
    if (!expectedVersion) return null;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await delay(10000);
        try {
            const snapshot = await ble.refreshSnapshot({ interactive: false });
            const current = snapshot.system?.version;
            if (typeof current === 'string') return current === expectedVersion;
        } catch {
            // Device still rebooting - keep polling
        }
    }
    return null;
}

// Re-establish the shared session after a mid-transfer link drop. The device
// needs a beat to notice the disconnect and restart advertising, so each
// attempt is preceded by a short wait.
async function reconnectAfterDrop(callbacks: OtaCallbacks): Promise<void> {
    for (let attempt = 1; attempt <= RECONNECT_ATTEMPTS; attempt++) {
        await delay(RECONNECT_DELAY_MS);
        callbacks.onStatus(
            `Reconnecting to grinder (attempt ${attempt}/${RECONNECT_ATTEMPTS})...`,
            'info',
        );
        try {
            await ble.connect({ interactive: false });
            return;
        } catch (error) {
            console.warn('Reconnect attempt failed:', error);
        }
    }
    throw new Error('The link dropped mid-transfer and the grinder could not be reached again');
}

// One full transfer over the current connection: START, chunk stream, END+CRC,
// then the device's own verdict. Returns the final status byte, or null when
// the link dropped after END was delivered (resolved by the caller via
// verifyVersionAfterReboot). A throw before END means nothing was applied -
// the caller may reconnect and call this again.
async function uploadOnce(
    firmwareData: Uint8Array,
    expectedVersion: string | null,
    callbacks: OtaCallbacks,
): Promise<number | null> {
    const otaService = await ble.getService(ble.UUIDS.OTA_SERVICE);
    const statusChar = await otaService.getCharacteristic(ble.UUIDS.OTA_STATUS);
    const controlChar = await otaService.getCharacteristic(ble.UUIDS.OTA_CONTROL);
    const dataChar = await otaService.getCharacteristic(ble.UUIDS.OTA_DATA);

    let currentStatus = 0;
    const onStatusUpdate = (event: Event) => {
        const target = event.target as BluetoothRemoteGATTCharacteristic;
        const value = target.value;
        if (value && value.byteLength > 0) {
            currentStatus = value.getUint8(0);
        }
    };
    await statusChar.startNotifications();
    statusChar.addEventListener('characteristicvaluechanged', onStatusUpdate);

    const waitForStatus = (
        predicate: (status: number) => boolean,
        timeoutMs: number,
        label: string,
    ) =>
        new Promise<number>((resolve, reject) => {
            const startTime = Date.now();
            const check = () => {
                if (predicate(currentStatus)) {
                    resolve(currentStatus);
                    return;
                }
                if (Date.now() - startTime > timeoutMs) {
                    reject(new Error(`Timeout waiting for ${label}`));
                    return;
                }
                setTimeout(check, 100);
            };
            check();
        });

    try {
        // Build start command:
        // [CMD][patch_size:4][is_full_update:1][build_number_length:1][firmware_version_length:1][firmware_version:M]
        const versionBytes = expectedVersion
            ? new TextEncoder().encode(expectedVersion)
            : new Uint8Array(0);
        const startData = new ArrayBuffer(1 + 4 + 1 + 1 + 1 + versionBytes.length);
        const startView = new DataView(startData);
        let offset = 0;
        startView.setUint8(offset, CMD_START);
        offset += 1;
        startView.setUint32(offset, firmwareData.length, true);
        offset += 4;
        // web-ota.bin is a detools patch created against an empty file - a
        // true full update, so the device must not use the running image as
        // the patch source.
        startView.setUint8(offset, 1);
        offset += 1;
        // Zero-length build number: the device verifies by firmware version;
        // a made-up build number could only cause false failures.
        startView.setUint8(offset, 0);
        offset += 1;
        startView.setUint8(offset, versionBytes.length);
        offset += 1;
        new Uint8Array(startData, offset).set(versionBytes);

        await controlChar.writeValue(startData);
        callbacks.onStatus('Sent start command, waiting for device...', 'info');
        await waitForStatus((s) => s === STATUS_RECEIVING, 15000, 'device ready');

        // Send firmware data in chunks; chunk writes can fail transiently
        // mid-transfer, so retry before giving up - unless the link itself is
        // gone, in which case retrying on the dead connection is pointless.
        callbacks.onStatus('Uploading firmware...', 'info');
        let chunkCount = 0;
        for (let i = 0; i < firmwareData.length; i += CHUNK_SIZE) {
            const chunk = firmwareData.slice(i, i + CHUNK_SIZE);
            for (let attempt = 1; ; attempt++) {
                try {
                    await dataChar.writeValue(chunk as BufferSource);
                    break;
                } catch (writeError) {
                    if (!ble.isConnected() || attempt >= 3) throw writeError;
                    console.warn(
                        `Chunk write failed at offset ${i} (attempt ${attempt}/3), retrying`,
                        writeError,
                    );
                    await delay(1000);
                }
            }
            chunkCount++;
            if (chunkCount % 10 === 0 || i + CHUNK_SIZE >= firmwareData.length) {
                const progress = Math.round(((i + chunk.length) / firmwareData.length) * 100);
                callbacks.onProgress(progress);
                callbacks.onStatus(`Uploading: ${progress}%`, 'info');
            }
        }

        // END + CRC-32 of the patch; the device verifies its staged copy
        // before applying. Then wait for the device's own verdict — treating
        // timeouts/disconnects as success would hide real failures.
        const endCommand = new Uint8Array(5);
        endCommand[0] = CMD_END;
        new DataView(endCommand.buffer).setUint32(1, crc32(firmwareData), true);
        await controlChar.writeValue(endCommand);
        callbacks.onStatus('Upload complete, applying update (takes 30-90s)...', 'info');

        try {
            return await waitForStatus(
                (s) => s === STATUS_SUCCESS || s === STATUS_ERROR,
                180000,
                'the device to apply the update',
            );
        } catch (applyError) {
            // END was delivered, so the device is applying/rebooting on its
            // own - resolved by the version check after reboot, not a retry.
            console.warn('No definitive OTA status:', applyError);
            return null;
        }
    } finally {
        statusChar.removeEventListener('characteristicvaluechanged', onStatusUpdate);
    }
}

// Connects (via the shared session) and flashes the given OTA binary URL.
// Holds the link for the whole upload + apply; a link drop during the upload
// reconnects and restarts the transfer, and the device's own success/error
// status is the verdict, with a version check after reboot as the fallback.
export async function connectAndFlash(
    firmwareUrl: string,
    expectedVersion: string | null,
    callbacks: OtaCallbacks,
): Promise<void> {
    callbacks.onStatus('Connecting to grinder...', 'info');
    await ble.connect({ interactive: true });

    // Own the link for the whole upload + apply. Without this, any concurrent
    // flow calling release() - the device strip's background snapshot refresh
    // is the usual culprit - arms the 30s idle timer and the GATT server
    // disconnects mid-transfer.
    ble.hold();
    try {
        const firmwareData = await downloadFirmware(firmwareUrl, callbacks);
        await verifyFirmwareDownload(firmwareUrl, firmwareData, callbacks);

        callbacks.onStatus('Starting firmware update...', 'info');
        callbacks.onProgress(0);
        if (expectedVersion) {
            callbacks.onStatus(`Installing version: ${expectedVersion}`, 'info');
        }

        let outcome: number | null = null;
        for (let attempt = 1; ; attempt++) {
            try {
                outcome = await uploadOnce(firmwareData, expectedVersion, callbacks);
                break;
            } catch (error) {
                // Restart only makes sense when the link itself died; errors
                // on a live connection (device rejected the update, END-stage
                // CRC mismatch) would just fail identically on a retry.
                if (ble.isConnected() || attempt >= MAX_TRANSFER_ATTEMPTS) throw error;
                console.warn(`Transfer attempt ${attempt} lost the link:`, error);
                callbacks.onStatus(
                    `Connection lost mid-upload - restarting transfer (attempt ${attempt + 1}/${MAX_TRANSFER_ATTEMPTS})...`,
                    'info',
                );
                callbacks.onProgress(0);
                await reconnectAfterDrop(callbacks);
            }
        }

        if (outcome === STATUS_ERROR) {
            throw new Error('The device reported the update failed while applying');
        }

        callbacks.onProgress(100);
        setTimeout(() => callbacks.onProgress(null), 3000);

        if (outcome === STATUS_SUCCESS) {
            callbacks.onStatus('Firmware update completed successfully!', 'success');
            // Refresh the cached snapshot once the device is back up so the
            // strip and update banner reflect the new version.
            setTimeout(() => {
                ble.refreshSnapshot({ interactive: false }).catch(() => {});
            }, 25000);
        } else {
            callbacks.onStatus('Update sent - reconnecting to verify...', 'info');
            const verified = await verifyVersionAfterReboot(expectedVersion);
            if (verified === true) {
                callbacks.onStatus(
                    `Update verified - device is running v${expectedVersion}`,
                    'success',
                );
            } else if (verified === false) {
                throw new Error(
                    `Device did not come back on v${expectedVersion} - the update failed`,
                );
            } else {
                callbacks.onStatus(
                    'Could not confirm the update - reconnect to check the firmware version',
                    'error',
                );
            }
        }
    } catch (error) {
        // Try to abort OTA on error so the device returns to idle; on a dead
        // link the device has already aborted by itself.
        if (ble.isConnected()) {
            try {
                const otaService = await ble.getService(ble.UUIDS.OTA_SERVICE);
                const controlChar = await otaService.getCharacteristic(ble.UUIDS.OTA_CONTROL);
                await controlChar.writeValue(new Uint8Array([CMD_ABORT]));
            } catch (abortError) {
                console.error('Could not send abort command:', abortError);
            }
        }
        throw error;
    } finally {
        ble.releaseHold();
        ble.release();
    }
}
