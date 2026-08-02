// Cloud store client (TypeScript port of the flasher's analytics/cloud.js;
// design: docs/CLOUD_SYNC.md). The browser is a full API client: it can
// create a store, push raw session blobs (backfill after a BLE pull) and
// pull the store's history into the same IndexedDB the BLE path fills.
//
// Credentials live in localStorage. upload_key is present only in the
// browser that provisioned the store; a browser linked via a shared
// dashboard link or a BLE claim holds just the read-only view_key.

import type { DeviceReports, StoredRecord } from '@/lib/analytics/types';
import { parseSessionFile } from '@/lib/parser';

const CONFIG_KEY = 'sgbwCloudStore';

export interface CloudConfig {
    storeId: string;
    uploadKey?: string;
    viewKey?: string;
    baseUrl: string;
    linkedAt: number;
}

declare global {
    interface Window {
        SGBW_API_BASE?: string;
    }
}

// Same-origin by default (the app serves its own API); window.SGBW_API_BASE
// overrides for split setups.
function apiBase(config?: CloudConfig | null): string {
    return config?.baseUrl || window.SGBW_API_BASE || '';
}

export function getCloudConfig(): CloudConfig | null {
    try {
        return JSON.parse(localStorage.getItem(CONFIG_KEY) ?? '') as CloudConfig;
    } catch {
        return null;
    }
}

export function saveCloudConfig(config: CloudConfig): void {
    try {
        localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    } catch {
        /* private mode */
    }
}

export function clearCloudConfig(): void {
    try {
        localStorage.removeItem(CONFIG_KEY);
    } catch {
        /* private mode */
    }
}

function authKey(config: CloudConfig): string {
    return config.uploadKey ?? config.viewKey ?? '';
}

async function errorMessage(response: Response): Promise<string> {
    try {
        const body = (await response.json()) as { error?: string };
        return body.error ?? `HTTP ${response.status}`;
    } catch {
        return `HTTP ${response.status}`;
    }
}

async function apiFetch(
    config: CloudConfig,
    path: string,
    init: RequestInit = {},
): Promise<Response> {
    const response = await fetch(`${apiBase(config)}/api/stores${path}`, {
        ...init,
        headers: {
            authorization: `Bearer ${authKey(config)}`,
            ...((init.headers as Record<string, string>) ?? {}),
        },
    });
    if (!response.ok) {
        throw new Error(await errorMessage(response));
    }
    return response;
}

// Creates a store on the API and persists the full credential set locally.
export async function createCloudStore(name: string | null): Promise<CloudConfig> {
    const response = await fetch(`${apiBase()}/api/stores`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
    });
    if (!response.ok) {
        throw new Error(`Could not create a cloud store (${await errorMessage(response)})`);
    }
    const created = (await response.json()) as {
        store_id: string;
        upload_key: string;
        view_key: string;
    };
    const config: CloudConfig = {
        storeId: created.store_id,
        uploadKey: created.upload_key,
        viewKey: created.view_key,
        baseUrl: window.SGBW_API_BASE ?? '',
        linkedAt: Date.now(),
    };
    saveCloudConfig(config);
    return config;
}

export interface StoreMeta {
    store_id: string;
    name: string | null;
    provisional: boolean;
    session_count: number;
    session_quota: number;
    role: 'read' | 'write';
}

export function fetchStoreMeta(config: CloudConfig): Promise<StoreMeta> {
    return apiFetch(config, `/${config.storeId}`).then((r) => r.json() as Promise<StoreMeta>);
}

export async function deleteCloudStore(config: CloudConfig): Promise<void> {
    await apiFetch(config, `/${config.storeId}`, { method: 'DELETE' });
}

export interface CloudSessionSummary {
    sha256: string;
    session_id: number;
    session_timestamp: number;
    [key: string]: unknown;
}

async function fetchSummaries(config: CloudConfig): Promise<CloudSessionSummary[]> {
    const response = await apiFetch(config, `/${config.storeId}/sessions`);
    const { sessions } = (await response.json()) as { sessions: CloudSessionSummary[] };
    return sessions;
}

// ---- share links ----------------------------------------------------------
// #store=<store_id>:<view_key>[@<base_url>] — read-only by construction: the
// link carries the view key only, never the upload key.

export function buildShareLink(config: CloudConfig): string {
    const base = apiBase(config);
    const suffix = base ? `@${base}` : '';
    return `${location.origin}/analytics#store=${config.storeId}:${config.viewKey}${suffix}`;
}

export function adoptShareFragment(): boolean {
    const match = location.hash.match(/^#store=(st_[0-9a-f]+):(vk_[0-9a-f]+)(?:@(.+))?$/);
    if (!match?.[1] || !match[2]) return false;
    const existing = getCloudConfig();
    // Never let a read-only link downgrade a browser that provisioned the store.
    if (existing?.storeId === match[1] && existing.uploadKey) {
        history.replaceState(null, '', location.pathname + location.search);
        return false;
    }
    saveCloudConfig({
        storeId: match[1],
        viewKey: match[2],
        baseUrl: match[3] ?? '',
        linkedAt: Date.now(),
    });
    history.replaceState(null, '', location.pathname + location.search);
    return true;
}

// ---- pull: cloud -> IndexedDB --------------------------------------------

export interface CloudProgress {
    index: number;
    total: number;
    message: string;
}

export interface CloudPullResult {
    records: StoredRecord[];
    errors: Array<{ sessionId: number; message: string }>;
    cloudTotal: number;
}

// Fetches every session the store holds that isn't already cached locally
// (by content hash), parses the raw blobs with the shared parser, and
// returns records in the exact shape the BLE pull produces.
export async function pullFromCloud(
    config: CloudConfig,
    knownShas: Set<string>,
    onProgress: (progress: CloudProgress) => void = () => {},
): Promise<CloudPullResult> {
    const summaries = await fetchSummaries(config);
    const missing = summaries.filter((s) => !knownShas.has(s.sha256));
    const records: StoredRecord[] = [];
    const errors: Array<{ sessionId: number; message: string }> = [];
    const pulledAt = new Date().toISOString();

    for (let i = 0; i < missing.length; i++) {
        const entry = missing[i];
        if (!entry) continue;
        onProgress({
            index: i,
            total: missing.length,
            message: `Downloading session #${entry.session_id} (${i + 1}/${missing.length}) from the cloud...`,
        });
        try {
            const response = await apiFetch(config, `/${config.storeId}/sessions/${entry.sha256}`);
            const buffer = await response.arrayBuffer();
            const { session, events, measurements } = parseSessionFile(buffer, entry.session_id);
            records.push({
                sha256: entry.sha256,
                session_id: session.session_id,
                session,
                events,
                measurements,
                raw: new Uint8Array(buffer),
                pulledAt,
                source: 'cloud',
            });
        } catch (error) {
            errors.push({
                sessionId: entry.session_id,
                message: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return { records, errors, cloudTotal: summaries.length };
}

// ---- push: browser backfill ----------------------------------------------

export interface CloudPushResult {
    stored: number;
    skipped: number;
    errors: Array<{ sessionId: number; message: string }>;
}

// Uploads local records the store doesn't hold yet, verbatim raw bytes so
// the content hash matches what the device itself would upload later.
// Idempotent by server-side dedup; requires the upload key.
export async function pushToCloud(
    config: CloudConfig,
    records: StoredRecord[],
    deviceId: string | null,
    onProgress: (progress: CloudProgress) => void = () => {},
): Promise<CloudPushResult> {
    if (!config.uploadKey) throw new Error('This browser holds a read-only link (no upload key)');
    const summaries = await fetchSummaries(config);
    const known = new Set(summaries.map((s) => s.sha256));
    const candidates = records.filter((r) => r.raw && r.sha256 && !known.has(r.sha256));

    let stored = 0;
    const errors: Array<{ sessionId: number; message: string }> = [];
    for (let i = 0; i < candidates.length; i++) {
        const record = candidates[i];
        if (!record?.raw) continue;
        onProgress({
            index: i,
            total: candidates.length,
            message: `Backing up session #${record.session_id} (${i + 1}/${candidates.length}) to the cloud...`,
        });
        try {
            const headers: Record<string, string> = {
                'content-type': 'application/octet-stream',
                'x-source': 'browser',
            };
            if (deviceId) headers['x-device-id'] = deviceId;
            const response = await apiFetch(config, `/${config.storeId}/sessions`, {
                method: 'POST',
                headers,
                body: record.raw as BodyInit,
            });
            const result = (await response.json()) as { status: string };
            if (result.status === 'stored') stored++;
        } catch (error) {
            errors.push({
                sessionId: record.session_id,
                message: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return { stored, skipped: records.length - candidates.length, errors };
}

// Pushes a compact health observation (same shape the firmware POSTs after
// its own syncs). Best-effort; the 4 KB server cap is respected by sending
// only the lightweight system/sessions JSONs, never diagnostics text.
export async function pushSnapshotToCloud(
    config: CloudConfig,
    health: DeviceReports | null,
    deviceId: string | null,
): Promise<boolean> {
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
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (deviceId) headers['x-device-id'] = deviceId;
    await apiFetch(config, `/${config.storeId}/snapshots`, { method: 'POST', headers, body });
    return true;
}
