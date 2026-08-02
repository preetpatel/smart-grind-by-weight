// Cloud store client for the sync API served by tools/web-server
// (docs/CLOUD_SYNC.md). The browser is a full API client: it can create a
// store, push raw session blobs (backfill after a BLE pull) and pull the
// store's history into the same IndexedDB the BLE path fills — every
// analytics view renders identically from either source.
//
// Credentials live in localStorage. upload_key is present only in the
// browser that provisioned the store; a browser linked via a shared
// dashboard link holds just the read-only view_key.

import { parseSessionFile } from './parser.js';

const CONFIG_KEY = 'sgbwCloudStore';

// Same-origin by default (the flasher is served by the web-server app);
// window.SGBW_API_BASE overrides for GH Pages -> hosted-API setups.
function apiBase(config) {
    return (config && config.baseUrl) || window.SGBW_API_BASE || '';
}

export function getCloudConfig() {
    try { return JSON.parse(localStorage.getItem(CONFIG_KEY)); } catch { return null; }
}

export function saveCloudConfig(config) {
    try { localStorage.setItem(CONFIG_KEY, JSON.stringify(config)); } catch { /* private mode */ }
}

export function clearCloudConfig() {
    try { localStorage.removeItem(CONFIG_KEY); } catch { /* private mode */ }
}

function authKey(config) {
    return config.uploadKey || config.viewKey;
}

async function apiFetch(config, path, options = {}) {
    const response = await fetch(`${apiBase(config)}/api/stores${path}`, {
        ...options,
        headers: {
            authorization: `Bearer ${authKey(config)}`,
            ...(options.headers || {}),
        },
    });
    if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try { message = (await response.json()).error || message; } catch { /* keep status */ }
        throw new Error(message);
    }
    return response;
}

// Creates a store on the API and persists the full credential set locally.
export async function createCloudStore(name) {
    const response = await fetch(`${window.SGBW_API_BASE || ''}/api/stores`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
    });
    if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try { message = (await response.json()).error || message; } catch { /* keep status */ }
        throw new Error(`Could not create a cloud store (${message})`);
    }
    const { store_id: storeId, upload_key: uploadKey, view_key: viewKey } = await response.json();
    const config = { storeId, uploadKey, viewKey, baseUrl: window.SGBW_API_BASE || '', linkedAt: Date.now() };
    saveCloudConfig(config);
    return config;
}

export function fetchStoreMeta(config) {
    return apiFetch(config, `/${config.storeId}`).then((r) => r.json());
}

export function deleteCloudStore(config) {
    return apiFetch(config, `/${config.storeId}`, { method: 'DELETE' });
}

async function fetchSummaries(config) {
    const { sessions } = await (await apiFetch(config, `/${config.storeId}/sessions`)).json();
    return sessions;
}

// ---- share links -----------------------------------------------------------
// #store=<store_id>:<view_key>[@<base_url>] — read-only by construction: the
// link carries the view key only, never the upload key.

export function buildShareLink(config) {
    const base = apiBase(config);
    const suffix = base ? `@${base}` : '';
    return `${location.origin}${location.pathname}#store=${config.storeId}:${config.viewKey}${suffix}`;
}

export function adoptShareFragment() {
    const match = location.hash.match(/^#store=(st_[0-9a-f]+):(vk_[0-9a-f]+)(?:@(.+))?$/);
    if (!match) return false;
    const existing = getCloudConfig();
    // Never let a read-only link downgrade a browser that provisioned the store.
    if (existing?.storeId === match[1] && existing.uploadKey) {
        history.replaceState(null, '', location.pathname + location.search);
        return false;
    }
    saveCloudConfig({ storeId: match[1], viewKey: match[2], baseUrl: match[3] || '', linkedAt: Date.now() });
    history.replaceState(null, '', location.pathname + location.search);
    return true;
}

// ---- pull: cloud -> IndexedDB ---------------------------------------------

// Fetches every session the store holds that isn't already cached locally
// (by content hash), parses the raw blobs with the shared parser, and returns
// records in the exact shape the BLE pull produces.
export async function pullFromCloud(config, knownShas, onProgress = () => {}) {
    const summaries = await fetchSummaries(config);
    const missing = summaries.filter((s) => !knownShas.has(s.sha256));
    const records = [];
    const errors = [];
    const pulledAt = new Date().toISOString();

    for (let i = 0; i < missing.length; i++) {
        const entry = missing[i];
        onProgress({
            index: i, total: missing.length,
            message: `Downloading session #${entry.session_id} (${i + 1}/${missing.length}) from the cloud...`,
        });
        try {
            const response = await apiFetch(config, `/${config.storeId}/sessions/${entry.sha256}`);
            const buffer = await response.arrayBuffer();
            const { session, events, measurements } = parseSessionFile(buffer, entry.session_id);
            records.push({
                sha256: entry.sha256,
                session_id: session.session_id,
                session, events, measurements,
                raw: new Uint8Array(buffer),
                pulledAt,
                source: 'cloud',
            });
        } catch (error) {
            errors.push({ sessionId: entry.session_id, message: error.message });
        }
    }
    return { records, errors, cloudTotal: summaries.length };
}

// ---- push: browser backfill ------------------------------------------------

// Uploads local records the store doesn't hold yet, verbatim raw bytes so the
// content hash matches what the device itself would upload later. Idempotent
// by server-side dedup; requires the upload key.
export async function pushToCloud(config, records, deviceId, onProgress = () => {}) {
    if (!config.uploadKey) throw new Error('This browser holds a read-only link (no upload key)');
    const summaries = await fetchSummaries(config);
    const known = new Set(summaries.map((s) => s.sha256));
    const candidates = records.filter((r) => r.raw && r.sha256 && !known.has(r.sha256));

    let stored = 0;
    const errors = [];
    for (let i = 0; i < candidates.length; i++) {
        const record = candidates[i];
        onProgress({
            index: i, total: candidates.length,
            message: `Backing up session #${record.session_id} (${i + 1}/${candidates.length}) to the cloud...`,
        });
        try {
            const headers = { 'content-type': 'application/octet-stream', 'x-source': 'browser' };
            if (deviceId) headers['x-device-id'] = deviceId;
            const response = await apiFetch(config, `/${config.storeId}/sessions`, {
                method: 'POST', headers, body: record.raw,
            });
            const result = await response.json();
            if (result.status === 'stored') stored++;
        } catch (error) {
            errors.push({ sessionId: record.session_id, message: error.message });
        }
    }
    return { stored, skipped: records.length - candidates.length, errors };
}

// Pushes a compact health observation (same shape the firmware will POST
// after its own syncs). Best-effort; the 4 KB server cap is respected by
// sending only the lightweight system/sessions JSONs, never diagnostics text.
export async function pushSnapshotToCloud(config, health, deviceId) {
    if (!config.uploadKey || !health?.system_info) return false;
    const payload = {
        source: 'browser',
        captured_at: health.captured_at,
        system_info: {
            system: health.system_info.system ?? null,
            sessions: health.system_info.sessions ?? null,
        },
    };
    const body = JSON.stringify(payload);
    if (body.length > 4096) return false;
    const headers = { 'content-type': 'application/json' };
    if (deviceId) headers['x-device-id'] = deviceId;
    await apiFetch(config, `/${config.storeId}/snapshots`, { method: 'POST', headers, body });
    return true;
}
