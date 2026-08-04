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

import type {
    Annotation,
    Bean,
    BeanAdvice,
    DeviceReports,
    StoredRecord,
} from '@/lib/analytics/types';
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

// Carries the server's `code` for the few failures the UI has to tell apart
// (a grinder registered to another account, mostly).
export class CloudApiError extends Error {
    readonly code: string | null;

    constructor(message: string, code: string | null) {
        super(message);
        this.code = code;
    }
}

async function apiError(response: Response): Promise<CloudApiError> {
    try {
        const body = (await response.json()) as { error?: string; code?: string };
        return new CloudApiError(body.error ?? `HTTP ${response.status}`, body.code ?? null);
    } catch {
        return new CloudApiError(`HTTP ${response.status}`, null);
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
        throw await apiError(response);
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
        throw await apiError(response);
    }
    return response;
}

// ---- owner store management ----------------------------------------------

export interface OwnedStore {
    store_id: string;
    name: string | null;
    view_key: string;
    // The grinder this store belongs to; null once released or claimed away,
    // which leaves the store as a readable archive.
    device_id: string | null;
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
    status?: 'created' | 'reused' | 'claimed';
}

// The grinder's own cloud store, created if it has none. Keyed on the device
// id, so this is safe to call from any browser at any time: the same grinder
// always lands on the same store instead of accumulating duplicates.
//
// `proof` is the store id + view key read off the grinder over BLE, which is
// what lets someone holding a second-hand grinder take it over (they get an
// empty store; the previous owner keeps their grinds). Throws CloudApiError
// with code 'device_bound_elsewhere' when it is registered elsewhere and no
// proof is available.
export async function claimStoreForDevice({
    deviceId,
    name = null,
    proof,
}: {
    deviceId: string;
    name?: string | null;
    proof?: { store_id: string; view_key: string };
}): Promise<ProvisionCredentials> {
    const response = await ownerFetch('/api/stores', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_id: deviceId, name, proof }),
    });
    return (await response.json()) as ProvisionCredentials;
}

// Mints a fresh upload key for a device write (invalidating the previous
// device credential — rotate-on-provision, docs/CLOUD_SYNC.md). Passing a
// device id also binds a store that has none yet.
export async function provisionStore(
    storeId: string,
    deviceId?: string | null,
): Promise<ProvisionCredentials> {
    const response = await ownerFetch(`/api/stores/${storeId}/provision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_id: deviceId ?? null }),
    });
    return (await response.json()) as ProvisionCredentials;
}

// Unbinds the grinder, keeping the store and its sessions as an archive. The
// deliberate way to hand a grinder on: the next account provisions it fresh.
export async function releaseStore(storeId: string): Promise<void> {
    await ownerFetch(`/api/stores/${storeId}/release`, { method: 'POST' });
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

// Leak recovery for a shared dashboard link: mints a fresh view key, which
// kills every existing share link. The grinder holds the old key too, so it
// must be re-provisioned before its BLE claim works again.
export async function rotateViewKey(storeId: string): Promise<string> {
    const response = await ownerFetch(`/api/stores/${storeId}/rotate-view-key`, {
        method: 'POST',
    });
    const { view_key } = (await response.json()) as { view_key: string };
    return view_key;
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
            message: `Downloading grind ${i + 1} of ${missing.length}…`,
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
            message: `Backing up grind ${i + 1} of ${candidates.length}…`,
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
            if (!response.ok) throw await apiError(response);
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
    if (!response.ok) throw await apiError(response);
    return true;
}

// ---- annotations ----------------------------------------------------------

// Annotations follow the same shape as everything else here: the browser holds
// the truth it can see, the store holds the copy that follows an account
// around, and the two are reconciled last-write-wins on updated_at.
export async function fetchAnnotations(source: CloudSource): Promise<Annotation[]> {
    const response = await apiFetch(source, `/${source.storeId}/annotations`);
    const { annotations } = (await response.json()) as { annotations: Annotation[] };
    return annotations;
}

export async function pushAnnotations(
    source: CloudSource,
    annotations: Annotation[],
): Promise<Annotation[]> {
    if (!annotations.length) return [];
    const response = await ownerFetch(`/api/stores/${source.storeId}/annotations`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ annotations }),
    });
    const body = (await response.json()) as { annotations: Annotation[] };
    return body.annotations;
}

// Deleting a grind for good: the server writes a tombstone so the device
// cannot re-upload it on the next sync.
export async function deleteCloudSession(source: CloudSource, sha256: string): Promise<void> {
    await ownerFetch(`/api/stores/${source.storeId}/sessions/${sha256}`, { method: 'DELETE' });
}

// ---- beans ----------------------------------------------------------------
// Beans live on the server (the grinder fetches the active one during its
// sync window), so unlike annotations there is no local-first merge: reads
// work with the view key, every mutation is an owner call.

export interface BeanList {
    beans: Bean[];
    active_bean_id: string | null;
}

export async function fetchBeans(source: CloudSource): Promise<BeanList> {
    const response = await apiFetch(source, `/${source.storeId}/beans`);
    return (await response.json()) as BeanList;
}

export interface BeanDraft {
    name: string;
    ratio: number;
    brew_time_s?: number;
    bag_size_g?: number | null;
    // The bag's stated recipe. Each range must be sent as a pair (or both
    // null to clear it); a yield range needs the dose it was quoted at.
    dose_g?: number | null;
    yield_min_g?: number | null;
    yield_max_g?: number | null;
    time_min_s?: number | null;
    time_max_s?: number | null;
    roast_date?: string | null;
    notes?: string | null;
}

export async function createBean(source: CloudSource, draft: BeanDraft): Promise<Bean> {
    const response = await ownerFetch(`/api/stores/${source.storeId}/beans`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draft),
    });
    const { bean } = (await response.json()) as { bean: Bean };
    return bean;
}

export async function updateBean(
    source: CloudSource,
    beanId: string,
    patch: Partial<BeanDraft> & { archived?: boolean },
): Promise<Bean> {
    const response = await ownerFetch(`/api/stores/${source.storeId}/beans/${beanId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
    });
    const { bean } = (await response.json()) as { bean: Bean };
    return bean;
}

export async function deleteBean(source: CloudSource, beanId: string): Promise<void> {
    await ownerFetch(`/api/stores/${source.storeId}/beans/${beanId}`, { method: 'DELETE' });
}

export async function activateBean(source: CloudSource, beanId: string): Promise<void> {
    await ownerFetch(`/api/stores/${source.storeId}/beans/${beanId}/activate`, { method: 'POST' });
}

// The same payload the grinder fetches during its sync window: active bean
// plus the server-computed verdict.
export async function fetchDeviceConfig(
    source: CloudSource,
): Promise<{ bean: Bean | null; advice: BeanAdvice }> {
    const response = await apiFetch(source, `/${source.storeId}/config`);
    return (await response.json()) as { bean: Bean | null; advice: BeanAdvice };
}
