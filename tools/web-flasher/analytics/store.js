// IndexedDB persistence for pulled grind data, plus JSON export/import.
//
// Canonical record shape (used in the store, the export file, and the
// tools/db-to-analytics-json.py dev dump):
//   { session_id, session: {...}, events: [...], measurements: [...], pulledAt }

const DB_NAME = 'sgbw-analytics';
const DB_VERSION = 1;
const SESSIONS_STORE = 'sessions';
const META_STORE = 'meta';

export const EXPORT_FORMAT = 'sgbw-analytics';
export const EXPORT_VERSION = 1;

function openDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(SESSIONS_STORE)) {
                db.createObjectStore(SESSIONS_STORE, { keyPath: 'session_id' });
            }
            if (!db.objectStoreNames.contains(META_STORE)) {
                db.createObjectStore(META_STORE, { keyPath: 'key' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function transactionDone(tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
}

export async function saveSessions(records) {
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

export async function loadSessions() {
    const db = await openDb();
    try {
        const tx = db.transaction(SESSIONS_STORE, 'readonly');
        const request = tx.objectStore(SESSIONS_STORE).getAll();
        await transactionDone(tx);
        return request.result.sort((a, b) => a.session_id - b.session_id);
    } finally {
        db.close();
    }
}

export async function clearAll() {
    const db = await openDb();
    try {
        const tx = db.transaction([SESSIONS_STORE, META_STORE], 'readwrite');
        tx.objectStore(SESSIONS_STORE).clear();
        tx.objectStore(META_STORE).clear();
        await transactionDone(tx);
    } finally {
        db.close();
    }
}

export async function saveMeta(key, value) {
    const db = await openDb();
    try {
        const tx = db.transaction(META_STORE, 'readwrite');
        tx.objectStore(META_STORE).put({ key, value });
        await transactionDone(tx);
    } finally {
        db.close();
    }
}

export async function loadMeta(key) {
    const db = await openDb();
    try {
        const tx = db.transaction(META_STORE, 'readonly');
        const request = tx.objectStore(META_STORE).get(key);
        await transactionDone(tx);
        return request.result ? request.result.value : null;
    } finally {
        db.close();
    }
}

export function buildExportJson(records, deviceReports = null) {
    const payload = {
        format: EXPORT_FORMAT,
        version: EXPORT_VERSION,
        exportedAt: new Date().toISOString(),
        sessions: records,
    };
    if (deviceReports) {
        payload.deviceReports = deviceReports;
    }
    return JSON.stringify(payload);
}

// Validates an imported JSON payload and returns { records, deviceReports }.
export function parseImportJson(text) {
    let payload;
    try {
        payload = JSON.parse(text);
    } catch {
        throw new Error('File is not valid JSON');
    }
    if (payload.format !== EXPORT_FORMAT) {
        throw new Error(`Unrecognized file format (expected "${EXPORT_FORMAT}")`);
    }
    if (!Array.isArray(payload.sessions)) {
        throw new Error('File has no sessions array');
    }
    const records = payload.sessions.map((record) => {
        if (!record.session || typeof record.session.session_id !== 'number') {
            throw new Error('A session record is missing its session data');
        }
        return {
            session_id: record.session.session_id,
            session: record.session,
            events: record.events || [],
            measurements: record.measurements || [],
            pulledAt: record.pulledAt || payload.exportedAt || null,
        };
    });
    return { records, deviceReports: payload.deviceReports || null };
}
