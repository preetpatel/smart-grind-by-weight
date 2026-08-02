// Test harness: routes run against an in-process PGlite Postgres wrapped in
// Drizzle (same ORM, same generated migrations as production) and injected
// via setDbForTests. Route handlers are invoked directly with real Request
// objects; `params` is passed as a plain object (Next awaits it, and awaiting
// a non-promise is a no-op).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { setDbForTests } from '../../lib/db.js';
import * as schema from '../../lib/schema.js';

import * as storesRoute from '../../app/api/stores/route.js';
import * as storeRoute from '../../app/api/stores/[id]/route.js';
import * as manifestRoute from '../../app/api/stores/[id]/manifest/route.js';
import * as sessionsRoute from '../../app/api/stores/[id]/sessions/route.js';
import * as blobRoute from '../../app/api/stores/[id]/sessions/[sha]/route.js';
import * as snapshotsRoute from '../../app/api/stores/[id]/snapshots/route.js';
import * as rotateRoute from '../../app/api/stores/[id]/rotate-view-key/route.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

let pglite = null;

export async function freshDb() {
    if (pglite) await pglite.close();
    pglite = new PGlite();
    const db = drizzle(pglite, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS });
    setDbForTests(db);
    return db;
}

export function request(method, path, { key, body, headers = {} } = {}) {
    const requestHeaders = { ...headers };
    if (key) requestHeaders.authorization = `Bearer ${key}`;
    let payload = body;
    if (body && !(body instanceof ArrayBuffer) && typeof body !== 'string') {
        payload = JSON.stringify(body);
        requestHeaders['content-type'] = 'application/json';
    }
    return new Request(`http://test.local${path}`, { method, headers: requestHeaders, body: payload });
}

export const api = {
    createStore: (opts = {}) => storesRoute.POST(request('POST', '/api/stores', opts)),
    getStore: (id, opts) => storeRoute.GET(request('GET', `/api/stores/${id}`, opts), { params: { id } }),
    deleteStore: (id, opts) => storeRoute.DELETE(request('DELETE', `/api/stores/${id}`, opts), { params: { id } }),
    postManifest: (id, opts) => manifestRoute.POST(request('POST', `/api/stores/${id}/manifest`, opts), { params: { id } }),
    ingest: (id, opts) => sessionsRoute.POST(request('POST', `/api/stores/${id}/sessions`, opts), { params: { id } }),
    listSessions: (id, opts) => sessionsRoute.GET(request('GET', `/api/stores/${id}/sessions`, opts), { params: { id } }),
    getBlob: (id, sha, opts) => blobRoute.GET(request('GET', `/api/stores/${id}/sessions/${sha}`, opts), { params: { id, sha } }),
    postSnapshot: (id, opts) => snapshotsRoute.POST(request('POST', `/api/stores/${id}/snapshots`, opts), { params: { id } }),
    listSnapshots: (id, opts) => snapshotsRoute.GET(request('GET', `/api/stores/${id}/snapshots`, opts), { params: { id } }),
    rotateViewKey: (id, opts) => rotateRoute.POST(request('POST', `/api/stores/${id}/rotate-view-key`, opts), { params: { id } }),
};

export async function newStore() {
    const response = await api.createStore();
    if (response.status !== 201) throw new Error(`store create failed: ${response.status}`);
    return response.json();
}
