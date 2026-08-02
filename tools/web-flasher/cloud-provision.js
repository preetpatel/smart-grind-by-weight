// Cloud backup provisioning for the WiFi & Sync tab (docs/CLOUD_SYNC.md).
//
// The flasher is the provisioner and the device is the credential: this
// module creates a store on the sync API, writes {url, store_id, upload_key,
// view_key} to the grinder over BLE (the same deferred-write pattern as WiFi
// credentials), and keeps the browser's own copy in localStorage so the
// Analytics tab renders from the cloud immediately.
//
// Wire format (src/config/bluetooth.h):
//   config char:  [0x01][url]\0[store_id]\0[upload_key]\0[view_key]\0  set
//                 [0x02]                                              forget
//   status char:  JSON readback; carries store_id + view_key so any browser
//                 can claim dashboard access by holding the grinder. The
//                 upload key is never readable back.

import {
    getCloudConfig, saveCloudConfig, createCloudStore, deleteCloudStore, clearCloudConfig,
} from './analytics/cloud.js';

const CLOUD_CONFIG_CHAR_UUID = '66778899-ff00-1111-2222-334455667788';
const CLOUD_STATUS_CHAR_UUID = '778899aa-ff00-1111-2222-334455667788';
const SYSINFO_SERVICE_UUID = '77889900-aabb-ccdd-eeff-112233445566';

const $ = (id) => document.getElementById(id);

function showStatus(message, type = 'info') {
    const statusDiv = $('cloudSyncStatus');
    statusDiv.textContent = message;
    statusDiv.className = `status ${type}`;
    statusDiv.style.display = 'block';
}

async function connectCloudChars() {
    await window.GrinderSession.connect();
    const service = await window.GrinderSession.getService(SYSINFO_SERVICE_UUID);
    const configChar = await service.getCharacteristic(CLOUD_CONFIG_CHAR_UUID);
    const statusChar = await service.getCharacteristic(CLOUD_STATUS_CHAR_UUID);
    return { configChar, statusChar };
}

async function readDeviceCloudStatus(statusChar) {
    const value = await statusChar.readValue();
    return JSON.parse(new TextDecoder().decode(value));
}

function buildConfigPayload(config) {
    const enc = new TextEncoder();
    const fields = [config.baseUrl, config.storeId, config.uploadKey, config.viewKey || ''];
    const encoded = fields.map((f) => enc.encode(f));
    const payload = new Uint8Array(1 + encoded.reduce((n, b) => n + b.length + 1, 0));
    payload[0] = 0x01;
    let offset = 1;
    for (const bytes of encoded) {
        payload.set(bytes, offset);
        offset += bytes.length;
        payload[offset++] = 0;
    }
    return payload;
}

function describeDeviceStatus(status) {
    if (!status.configured) return 'No cloud store on the grinder yet.';
    const parts = [`Store ${status.store_id}${status.enabled ? '' : ' (sync turned off on the grinder)'}`];
    const stateText = {
        syncing: 'Uploading sessions now…',
        idle: {
            success: 'Up to date',
            partial: 'Partially synced — the next WiFi window continues',
            failed: 'Server unreachable on the last attempt',
            aborted: 'Last attempt was interrupted (grinder was busy)',
            none: status.unsynced ? 'Waiting for the next WiFi window' : 'Nothing to sync yet',
        }[status.last_result] || status.last_result,
    }[status.state] || status.state;
    parts.push(stateText);
    if (status.last_success_epoch) {
        parts.push(`last synced ${new Date(status.last_success_epoch * 1000).toLocaleString()}`);
    }
    return parts.join(' · ');
}

// The device must be able to reach this URL from its own network, so
// localhost is meaningless to it. SGBW_API_BASE overrides for split setups.
function apiBaseForDevice() {
    const base = window.SGBW_API_BASE || location.origin;
    if (/^https?:\/\/(localhost|127\.)/.test(base) && !window.SGBW_API_BASE) {
        throw new Error('This page is served from localhost, which the grinder cannot reach. '
            + 'Set window.SGBW_API_BASE to your server\'s LAN address first.');
    }
    return base;
}

async function setUpCloudBackup() {
    const button = $('cloudSetupBtn');
    button.disabled = true;
    try {
        // Reuse this browser's store if it already provisioned one; otherwise
        // mint a fresh store on the API.
        let config = getCloudConfig();
        if (!config?.uploadKey) {
            showStatus('Creating your cloud store…');
            apiBaseForDevice();
            config = await createCloudStore(window.GrinderSession?.getActive?.()?.label || null);
        }
        if (!config.baseUrl) {
            config = { ...config, baseUrl: apiBaseForDevice() };
            saveCloudConfig(config);
        }

        showStatus('Connecting to grinder…');
        const { configChar, statusChar } = await connectCloudChars();
        await configChar.writeValue(buildConfigPayload({
            ...config,
            baseUrl: config.baseUrl || apiBaseForDevice(),
        }));

        // The write is applied on the grinder's bluetooth task; give it a
        // beat, then read back the (secret-free) status to confirm.
        await new Promise((resolve) => setTimeout(resolve, 600));
        const status = await readDeviceCloudStatus(statusChar);
        window.GrinderSession.applyPatch({ cloud: status });
        if (status.configured) {
            showStatus(`✓ Cloud backup is on. Sessions upload after every grind over WiFi — ${describeDeviceStatus(status)}`, 'success');
        } else {
            showStatus('The grinder did not accept the configuration — try again.', 'error');
        }
    } catch (error) {
        console.error('Cloud setup error:', error);
        showStatus(`Cloud setup failed: ${error.message}`, 'error');
    } finally {
        window.GrinderSession?.release?.();
        button.disabled = false;
    }
}

async function checkCloudStatus() {
    try {
        showStatus('Connecting to grinder…');
        const { statusChar } = await connectCloudChars();
        const status = await readDeviceCloudStatus(statusChar);
        window.GrinderSession.applyPatch({ cloud: status });

        // Claim by possession: any browser reading a provisioned grinder gets
        // the read-only keys and can open the dashboard.
        const local = getCloudConfig();
        if (status.configured && status.view_key && !local) {
            saveCloudConfig({
                storeId: status.store_id,
                viewKey: status.view_key,
                baseUrl: status.server_url || '',
                linkedAt: Date.now(),
            });
            showStatus(`${describeDeviceStatus(status)} · This browser is now linked — open Analytics to see the dashboard.`, 'success');
            return;
        }
        showStatus(describeDeviceStatus(status), status.last_result === 'success' ? 'success' : 'info');
    } catch (error) {
        console.error('Cloud status error:', error);
        showStatus(`Could not read cloud sync status: ${error.message}`, 'error');
    } finally {
        window.GrinderSession?.release?.();
    }
}

async function forgetCloudSync() {
    if (!confirm('Remove the cloud store keys from the grinder? Sessions already uploaded stay on the server.')) return;
    try {
        showStatus('Connecting to grinder…');
        const { configChar } = await connectCloudChars();
        await configChar.writeValue(new Uint8Array([0x02]));
        window.GrinderSession.applyPatch({ cloud: { configured: false } });

        const config = getCloudConfig();
        if (config?.uploadKey && confirm('Also permanently delete the cloud store and every session in it?')) {
            await deleteCloudStore(config);
            clearCloudConfig();
            showStatus('✓ Sync removed from the grinder and the cloud store deleted.', 'success');
        } else {
            showStatus('✓ Sync removed from the grinder. The cloud store (and this browser\'s link to it) remains.', 'success');
        }
    } catch (error) {
        console.error('Cloud forget error:', error);
        showStatus(`Could not forget cloud sync: ${error.message}`, 'error');
    } finally {
        window.GrinderSession?.release?.();
    }
}

function init() {
    $('cloudSetupBtn')?.addEventListener('click', setUpCloudBackup);
    $('cloudCheckBtn')?.addEventListener('click', checkCloudStatus);
    $('cloudForgetBtn')?.addEventListener('click', forgetCloudSync);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
