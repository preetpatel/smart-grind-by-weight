// Cloud store client (design: docs/CLOUD_SYNC.md).
//
// Two kinds of access, mirroring the server's auth model:
//  - OWNER: the signed-in account. Same-origin requests ride the session
//    cookie — no credentials in browser storage at all. Store management
//    (create / provision / rename / delete) is owner-only.
//  - VIEWER: a read-only link (#store= share link, or keys read off a grinder
//    over BLE). Just {store_id, view_key, base_url} in localStorage; reads
//    authenticate with the view key as a bearer token, which also covers the
//    cross-origin case (a hosted dashboard reading a self-hosted store).

import type { DeviceReports, StoredRecord } from '@/lib/analytics/types';
import { parseSessionFile } from '@/lib/parser';

const VIEWER_KEY = 'sgbwCloudViewer';
const ACTIVE_STORE_KEY = 'sgbwActiveStore';
// Pre-account versions kept full credentials here; drop them on sight.
const LEGACY_CONFIG_KEY = 'sgbwCloudStore';

export interface CloudSource {
    storeId: string;
    viewKey: string;
    baseUrl: string; // '' = same origin
    owned: boolean;
    name?: string | null;
}

export interface ViewerSource {
    storeId: string;
    viewKey: string;
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
function apiBase(baseUrl?: string): string {
    return baseUrl || window.SGBW_API_BASE || '';
}

// ---- viewer source (localStorage) -----------------------------------------

export function getViewerSource(): ViewerSource | null {
    try {
        localStorage.removeItem(LEGACY_CONFIG_KEY);
        return JSON.parse(localStorage.getItem(VIEWER_KEY) ?? '') as ViewerSource;
    } catch {
        return null;
    }
}

export function saveViewerSource(source: ViewerSource): void {
    try {
        localStorage.setItem(VIEWER_KEY, JSON.stringify(source));
    } catch {
        /* private mode */
    }
}

export function clearViewerSource(): void {
    try {
        localStorage.removeItem(VIEWER_KEY);
    } catch {
        /* private mode */
    }
}

// The analytics page's preferred store for accounts that own several.
export function getActiveStoreId(): string | null {
    try {
        return localStorage.getItem(ACTIVE_STORE_KEY);
    } catch {
        return null;
    }
}

export function setActiveStoreId(storeId: string): void {
    try {
        localStorage.setItem(ACTIVE_STORE_KEY, storeId);
    } catch {
        /* private mode */
    }
}

// ---- HTTP helpers ---------------------------------------------------------

async function errorMessage(response: Response): Promise<string> {
    try {
        const body = (await response.json()) as { error?: string };
        return body.error ?? `HTTP ${response.status}`;
    } catch {
        return `HTTP ${response.status}`;
    }
}

// Store-data fetch: bearer view key when the source carries one (works
// cross-origin); the session cookie rides along same-origin anyway and wins
// for owned stores, so writes work without any key.
async function apiFetch(
    source: CloudSource,
    path: string,
    init: RequestInit = {},
): Promise<Response> {
    const headers: Record<string, string> = {
        ...((init.headers as Record<string, string>) ?? {}),
    };
    if (source.viewKey) headers.authorization = `Bearer ${source.viewKey}`;
    const response = await fetch(`${apiBase(source.baseUrl)}/api/stores${path}`, {
        ...init,
        headers,
    });
    if (!response.ok) {
        throw new Error(await errorMessage(response));
    }
    return response;
}

// Owner management call: session cookie only, same origin.
async function ownerFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(`${apiBase()}${path}`, init);
    if (response.status === 401) {
        throw new Error('Sign in first (top right) to manage cloud backups');
    }
    if (!response.ok) {
        throw new Error(await errorMessage(response));
    }
    return response;
}

// ---- owner store management ----------------------------------------------

export interface OwnedStore {
    store_id: string;
    name: string | null;
    view_key: string;
    created_at: string;
    session_count: number;
    last_received_at: string | null;
}

export async function listMyStores(): Promise<OwnedStore[]> {
    const response = await ownerFetch('/api/me/stores');
    const { stores } = (await response.json()) as { stores: OwnedStore[] };
    return stores;
}

export interface ProvisionCredentials {
    store_id: string;
    upload_key: string;
    view_key: string;
}

// Creates a store owned by the signed-in account. The returned upload key
// exists only for the caller's immediate BLE provisioning write.
export async function createCloudStore(name: string | null): Promise<ProvisionCredentials> {
    const response = await ownerFetch('/api/stores', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
    });
    return (await response.json()) as ProvisionCredentials;
}

// Mints a fresh upload key for a device write (invalidating the previous
// device credential — rotate-on-provision, docs/CLOUD_SYNC.md).
export async function provisionStore(storeId: string): Promise<ProvisionCredentials> {
    const response = await ownerFetch(`/api/stores/${storeId}/provision`, { method: 'POST' });
    return (await response.json()) as ProvisionCredentials;
}

export async function renameStore(storeId: string, name: string): Promise<void> {
    await ownerFetch(`/api/stores/${storeId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
    });
}

export async function deleteStore(storeId: string): Promise<void> {
    await ownerFetch(`/api/stores/${storeId}`, { method: 'DELETE' });
}

// ---- store metadata -------------------------------------------------------

export interface StoreMeta {
    store_id: string;
    name: string | null;
    session_count: number;
    session_quota: number;
    role: 'read' | 'write';
}

export function fetchStoreMeta(source: CloudSource): Promise<StoreMeta> {
    return apiFetch(source, `/${source.storeId}`).then((r) => r.json() as Promise<StoreMeta>);
}

export interface CloudSessionSummary {
    sha256: string;
    session_id: number;
    session_timestamp: number;
    [key: string]: unknown;
}

async function fetchSummaries(source: CloudSource): Promise<CloudSessionSummary[]> {
    const response = await apiFetch(source, `/${source.storeId}/sessions`);
    const { sessions } = (await response.json()) as { sessions: CloudSessionSummary[] };
    return sessions;
}

// ---- share links ----------------------------------------------------------
// #store=<store_id>:<view_key>[@<base_url>] — read-only by construction: the
// link carries the view key only, never a write credential.

export function buildShareLink(source: CloudSource): string {
    const base = apiBase(source.baseUrl);
    const suffix = base ? `@${base}` : '';
    return `${location.origin}/analytics#store=${source.storeId}:${source.viewKey}${suffix}`;
}

export function adoptShareFragment(): boolean {
    const match = location.hash.match(/^#store=(st_[0-9a-f]+):(vk_[0-9a-f]+)(?:@(.+))?$/);
    if (!match?.[1] || !match[2]) return false;
    saveViewerSource({
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
    source: CloudSource,
    knownShas: Set<string>,
    onProgress: (progress: CloudProgress) => void = () => {},
): Promise<CloudPullResult> {
    const summaries = await fetchSummaries(source);
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
            const response = await apiFetch(source, `/${source.storeId}/sessions/${entry.sha256}`);
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
// Idempotent by server-side dedup; write access comes from the owner's
// session cookie, so this only works on owned (same-origin) stores.
export async function pushToCloud(
    source: CloudSource,
    records: StoredRecord[],
    deviceId: string | null,
    onProgress: (progress: CloudProgress) => void = () => {},
): Promise<CloudPushResult> {
    if (!source.owned) throw new Error('This browser holds a read-only link');
    const summaries = await fetchSummaries(source);
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
            const response = await fetch(
                `${apiBase(source.baseUrl)}/api/stores/${source.storeId}/sessions`,
                { method: 'POST', headers, body: record.raw as BodyInit },
            );
            if (!response.ok) throw new Error(await errorMessage(response));
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
    source: CloudSource,
    health: DeviceReports | null,
    deviceId: string | null,
): Promise<boolean> {
    if (!source.owned || !health?.system_info) return false;
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
    const response = await fetch(
        `${apiBase(source.baseUrl)}/api/stores/${source.storeId}/snapshots`,
        { method: 'POST', headers, body },
    );
    if (!response.ok) throw new Error(await errorMessage(response));
    return true;
}
