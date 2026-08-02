// IndexedDB persistence for pulled grind data, plus JSON export/import
// (TypeScript port of the flasher's analytics/store.js).
//
// v2: records are keyed by sha256 of the raw session file, so a session
// arriving twice (BLE pull and cloud sync) lands on one record, and a
// factory-reset grinder's reborn session ids don't collide. `raw` holds the
// verbatim device bytes for the cloud backfill (docs/CLOUD_SYNC.md).
//
// v3 adds annotations — what the grinder can't know, keyed by the same sha256.
// They are written locally first and work with no account at all; syncing to a
// cloud store is an extra, not a requirement.
//
// v4 adds a read cache of the store's beans (server-authoritative) so the
// beans page and the annotation picker render offline.
import type { Annotation, Bean, DeviceReports, StoredRecord } from './types';

const DB_NAME = 'sgbw-analytics';
const DB_VERSION = 4;
const SESSIONS_STORE = 'sessions';
const META_STORE = 'meta';
const ANNOTATIONS_STORE = 'annotations';
const BEANS_STORE = 'beans';

export const EXPORT_FORMAT = 'sgbw-analytics';
export const EXPORT_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (event) => {
            const db = request.result;
            // v1 was keyed by session_id and held no raw bytes; the data is
            // re-pullable (device or cloud), so that one migration started
            // fresh. Later upgrades must keep sessions — a BLE-only browser
            // has nowhere to re-pull months of history from.
            if (event.oldVersion < 2 && db.objectStoreNames.contains(SESSIONS_STORE)) {
                db.deleteObjectStore(SESSIONS_STORE);
            }
            if (!db.objectStoreNames.contains(SESSIONS_STORE)) {
                db.createObjectStore(SESSIONS_STORE, { keyPath: 'sha256' });
            }
            if (!db.objectStoreNames.contains(META_STORE)) {
                db.createObjectStore(META_STORE, { keyPath: 'key' });
            }
            // Annotations are user-authored and not re-pullable from anywhere
            // else, so unlike sessions this store is created, never dropped.
            if (!db.objectStoreNames.contains(ANNOTATIONS_STORE)) {
                db.createObjectStore(ANNOTATIONS_STORE, { keyPath: 'sha256' });
            }
            if (!db.objectStoreNames.contains(BEANS_STORE)) {
                db.createObjectStore(BEANS_STORE, { keyPath: 'id' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
}

export async function saveSessions(records: StoredRecord[]): Promise<void> {
    if (!records.length) return;
    const db = await openDb();
    try {
        const tx = db.transaction(SESSIONS_STORE, 'readwrite');
        const store = tx.objectStore(SESSIONS_STORE);
        for (const record of records) {
            store.put(record);
        }
        await transactionDone(tx);
    } finally {
        db.close();
    }
}

export async function loadSessions(): Promise<StoredRecord[]> {
    const db = await openDb();
    try {
        const tx = db.transaction(SESSIONS_STORE, 'readonly');
        const request = tx.objectStore(SESSIONS_STORE).getAll();
        await transactionDone(tx);
        // Stable session order for the views; timestamp breaks ties between
        // a reborn id and its pre-factory-reset namesake.
        return (request.result as StoredRecord[]).sort(
            (a, b) =>
                a.session_id - b.session_id ||
                a.session.session_timestamp - b.session.session_timestamp,
        );
    } finally {
        db.close();
    }
}

// Removes one grind and any annotation on it. The grinder keeps its own copy;
// only the cloud tombstone makes a delete permanent across a re-sync.
export async function removeSession(sha256: string): Promise<void> {
    const db = await openDb();
    try {
        const tx = db.transaction([SESSIONS_STORE, ANNOTATIONS_STORE], 'readwrite');
        tx.objectStore(SESSIONS_STORE).delete(sha256);
        tx.objectStore(ANNOTATIONS_STORE).delete(sha256);
        await transactionDone(tx);
    } finally {
        db.close();
    }
}

export async function clearAll(): Promise<void> {
    const db = await openDb();
    try {
        const tx = db.transaction(
            [SESSIONS_STORE, META_STORE, ANNOTATIONS_STORE, BEANS_STORE],
            'readwrite',
        );
        tx.objectStore(SESSIONS_STORE).clear();
        tx.objectStore(META_STORE).clear();
        tx.objectStore(ANNOTATIONS_STORE).clear();
        tx.objectStore(BEANS_STORE).clear();
        await transactionDone(tx);
    } finally {
        db.close();
    }
}

export async function saveMeta(key: string, value: unknown): Promise<void> {
    const db = await openDb();
    try {
        const tx = db.transaction(META_STORE, 'readwrite');
        tx.objectStore(META_STORE).put({ key, value });
        await transactionDone(tx);
    } finally {
        db.close();
    }
}

export async function loadMeta<T>(key: string): Promise<T | null> {
    const db = await openDb();
    try {
        const tx = db.transaction(META_STORE, 'readonly');
        const request = tx.objectStore(META_STORE).get(key);
        await transactionDone(tx);
        const row = request.result as { key: string; value: T } | undefined;
        return row ? row.value : null;
    } finally {
        db.close();
    }
}

// ---- annotations ----------------------------------------------------------

export async function loadAnnotations(): Promise<Annotation[]> {
    const db = await openDb();
    try {
        const tx = db.transaction(ANNOTATIONS_STORE, 'readonly');
        const request = tx.objectStore(ANNOTATIONS_STORE).getAll();
        await transactionDone(tx);
        return request.result as Annotation[];
    } finally {
        db.close();
    }
}

export async function saveAnnotations(entries: Annotation[]): Promise<void> {
    if (!entries.length) return;
    const db = await openDb();
    try {
        const tx = db.transaction(ANNOTATIONS_STORE, 'readwrite');
        const store = tx.objectStore(ANNOTATIONS_STORE);
        for (const entry of entries) store.put(entry);
        await transactionDone(tx);
    } finally {
        db.close();
    }
}

// True when every field is empty — the annotation exists only as a tombstone
// of an edit that cleared it, which still has to sync so other browsers drop
// their copy too.
export function isBlankAnnotation(entry: Annotation): boolean {
    return (
        !entry.bean &&
        !entry.roast_date &&
        !entry.grind_setting &&
        !entry.note &&
        entry.tags.length === 0 &&
        !entry.bean_id &&
        entry.brew_output_g == null &&
        entry.brew_time_s == null
    );
}

// ---- beans (read cache; the cloud store is the source of truth) -----------

export async function saveBeansCache(beans: Bean[], activeBeanId: string | null): Promise<void> {
    const db = await openDb();
    try {
        const tx = db.transaction([BEANS_STORE, META_STORE], 'readwrite');
        const store = tx.objectStore(BEANS_STORE);
        // Replace-all: deletions on the server must not linger here.
        store.clear();
        for (const bean of beans) store.put(bean);
        tx.objectStore(META_STORE).put({ key: 'activeBeanId', value: activeBeanId });
        await transactionDone(tx);
    } finally {
        db.close();
    }
}

export async function loadBeansCache(): Promise<{ beans: Bean[]; activeBeanId: string | null }> {
    const db = await openDb();
    try {
        const tx = db.transaction([BEANS_STORE, META_STORE], 'readonly');
        const beansRequest = tx.objectStore(BEANS_STORE).getAll();
        const activeRequest = tx.objectStore(META_STORE).get('activeBeanId');
        await transactionDone(tx);
        const active = activeRequest.result as { key: string; value: string | null } | undefined;
        return {
            beans: beansRequest.result as Bean[],
            activeBeanId: active ? active.value : null,
        };
    } finally {
        db.close();
    }
}

export function buildExportJson(
    records: StoredRecord[],
    deviceReports: DeviceReports | null,
    annotations: Annotation[] = [],
): string {
    const payload: Record<string, unknown> = {
        format: EXPORT_FORMAT,
        version: EXPORT_VERSION,
        exportedAt: new Date().toISOString(),
        // Raw device bytes stay out of the JSON export (it's a parsed-data
        // interchange format; the cloud store is the raw archive).
        sessions: records.map(({ raw: _raw, ...rest }) => rest),
    };
    if (deviceReports) {
        payload.deviceReports = deviceReports;
    }
    if (annotations.length) {
        payload.annotations = annotations;
    }
    return JSON.stringify(payload);
}

// Validates an imported JSON payload and returns { records, deviceReports }.
export function parseImportJson(text: string): {
    records: StoredRecord[];
    deviceReports: DeviceReports | null;
    annotations: Annotation[];
} {
    let payload: Record<string, unknown>;
    try {
        payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
        throw new Error('File is not valid JSON');
    }
    if (payload.format !== EXPORT_FORMAT) {
        throw new Error(`Unrecognized file format (expected "${EXPORT_FORMAT}")`);
    }
    if (!Array.isArray(payload.sessions)) {
        throw new Error('File has no sessions array');
    }
    const exportedAt = typeof payload.exportedAt === 'string' ? payload.exportedAt : null;
    const records = (payload.sessions as Array<Partial<StoredRecord>>).map((record) => {
        if (!record.session || typeof record.session.session_id !== 'number') {
            throw new Error('A session record is missing its session data');
        }
        return {
            // Pre-v2 exports carry no hash; synthesize a stable key so the
            // record can live in the sha256-keyed store (no raw bytes, so
            // these records are view-only and skipped by the cloud backfill).
            sha256:
                record.sha256 ??
                `import:${record.session.session_id}:${record.session.session_timestamp}`,
            session_id: record.session.session_id,
            session: record.session,
            events: record.events ?? [],
            measurements: record.measurements ?? [],
            pulledAt: record.pulledAt ?? exportedAt,
            source: record.source ?? 'import',
        } satisfies StoredRecord;
    });
    const annotations = Array.isArray(payload.annotations)
        ? (payload.annotations as Annotation[]).filter(
              (entry) => entry && typeof entry.sha256 === 'string',
          )
        : [];
    return {
        records,
        deviceReports: (payload.deviceReports as DeviceReports | undefined) ?? null,
        annotations,
    };
}
