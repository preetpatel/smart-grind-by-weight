// Test harness: routes run against an in-process PGlite Postgres wrapped in
// Drizzle (same ORM, same generated migrations as production) and injected
// via setDbForTests. Route handlers are invoked directly with real Request
// objects.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as manifestRoute from '@/app/api/stores/[id]/manifest/route';
import * as rotateRoute from '@/app/api/stores/[id]/rotate-view-key/route';
import * as storeRoute from '@/app/api/stores/[id]/route';
import * as blobRoute from '@/app/api/stores/[id]/sessions/[sha]/route';
import * as sessionsRoute from '@/app/api/stores/[id]/sessions/route';
import * as snapshotsRoute from '@/app/api/stores/[id]/snapshots/route';
import * as storesRoute from '@/app/api/stores/route';
import { type Db, setDbForTests } from '@/lib/db';
import * as schema from '@/lib/schema';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

let pglite: PGlite | null = null;

export async function freshDb(): Promise<Db> {
    if (pglite) await pglite.close();
    pglite = new PGlite();
    const db = drizzle(pglite, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS });
    // Structurally identical to the node-postgres Drizzle instance; the cast
    // keeps production code typed against the real driver.
    setDbForTests(db as unknown as Db);
    return db as unknown as Db;
}

export interface RequestOptions {
    key?: string;
    body?: ArrayBuffer | string | object;
    headers?: Record<string, string>;
}

export function request(
    method: string,
    requestPath: string,
    { key, body, headers = {} }: RequestOptions = {},
): Request {
    const requestHeaders: Record<string, string> = { ...headers };
    if (key) requestHeaders.authorization = `Bearer ${key}`;
    let payload: BodyInit | undefined;
    if (body instanceof ArrayBuffer || typeof body === 'string') {
        payload = body;
    } else if (body !== undefined) {
        payload = JSON.stringify(body);
        requestHeaders['content-type'] = 'application/json';
    }
    return new Request(`http://test.local${requestPath}`, {
        method,
        headers: requestHeaders,
        body: payload,
    });
}

const ctx = (params: Record<string, string>) =>
    ({ params: Promise.resolve(params) }) as { params: Promise<never> };

export const api = {
    createStore: (opts: RequestOptions = {}) =>
        storesRoute.POST(request('POST', '/api/stores', opts)),
    getStore: (id: string, opts: RequestOptions) =>
        storeRoute.GET(request('GET', `/api/stores/${id}`, opts), ctx({ id })),
    deleteStore: (id: string, opts: RequestOptions) =>
        storeRoute.DELETE(request('DELETE', `/api/stores/${id}`, opts), ctx({ id })),
    postManifest: (id: string, opts: RequestOptions) =>
        manifestRoute.POST(request('POST', `/api/stores/${id}/manifest`, opts), ctx({ id })),
    ingest: (id: string, opts: RequestOptions) =>
        sessionsRoute.POST(request('POST', `/api/stores/${id}/sessions`, opts), ctx({ id })),
    listSessions: (id: string, opts: RequestOptions) =>
        sessionsRoute.GET(request('GET', `/api/stores/${id}/sessions`, opts), ctx({ id })),
    getBlob: (id: string, sha: string, opts: RequestOptions) =>
        blobRoute.GET(request('GET', `/api/stores/${id}/sessions/${sha}`, opts), ctx({ id, sha })),
    postSnapshot: (id: string, opts: RequestOptions) =>
        snapshotsRoute.POST(request('POST', `/api/stores/${id}/snapshots`, opts), ctx({ id })),
    listSnapshots: (id: string, opts: RequestOptions) =>
        snapshotsRoute.GET(request('GET', `/api/stores/${id}/snapshots`, opts), ctx({ id })),
    rotateViewKey: (id: string, opts: RequestOptions) =>
        rotateRoute.POST(request('POST', `/api/stores/${id}/rotate-view-key`, opts), ctx({ id })),
};

export interface StoreCredentials {
    store_id: string;
    upload_key: string;
    view_key: string;
}

export async function newStore(): Promise<StoreCredentials> {
    const response = await api.createStore();
    if (response.status !== 201) throw new Error(`store create failed: ${response.status}`);
    return (await response.json()) as StoreCredentials;
}
