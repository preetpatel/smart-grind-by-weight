// Test harness: routes run against an in-process PGlite Postgres wrapped in
// Drizzle (same ORM, same generated migrations as production) and injected
// via setDbForTests. Route handlers are invoked directly with real Request
// objects.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as authRoute from '@/app/api/auth/[...all]/route';
import * as myStoresRoute from '@/app/api/me/stores/route';
import * as annotationsRoute from '@/app/api/stores/[id]/annotations/route';
import * as beanActivateRoute from '@/app/api/stores/[id]/beans/[beanId]/activate/route';
import * as beanRoute from '@/app/api/stores/[id]/beans/[beanId]/route';
import * as beansRoute from '@/app/api/stores/[id]/beans/route';
import * as brewsRoute from '@/app/api/stores/[id]/brews/route';
import * as configRoute from '@/app/api/stores/[id]/config/route';
import * as manifestRoute from '@/app/api/stores/[id]/manifest/route';
import * as provisionRoute from '@/app/api/stores/[id]/provision/route';
import * as releaseRoute from '@/app/api/stores/[id]/release/route';
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
    cookie?: string;
    body?: ArrayBuffer | string | object;
    headers?: Record<string, string>;
}

export function request(
    method: string,
    requestPath: string,
    { key, cookie, body, headers = {} }: RequestOptions = {},
): Request {
    const requestHeaders: Record<string, string> = { ...headers };
    if (key) requestHeaders.authorization = `Bearer ${key}`;
    if (cookie) requestHeaders.cookie = cookie;
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
    deleteSession: (id: string, sha: string, opts: RequestOptions) =>
        blobRoute.DELETE(
            request('DELETE', `/api/stores/${id}/sessions/${sha}`, opts),
            ctx({ id, sha }),
        ),
    getAnnotations: (id: string, opts: RequestOptions) =>
        annotationsRoute.GET(request('GET', `/api/stores/${id}/annotations`, opts), ctx({ id })),
    putAnnotations: (id: string, opts: RequestOptions) =>
        annotationsRoute.PUT(request('PUT', `/api/stores/${id}/annotations`, opts), ctx({ id })),
    postSnapshot: (id: string, opts: RequestOptions) =>
        snapshotsRoute.POST(request('POST', `/api/stores/${id}/snapshots`, opts), ctx({ id })),
    listSnapshots: (id: string, opts: RequestOptions) =>
        snapshotsRoute.GET(request('GET', `/api/stores/${id}/snapshots`, opts), ctx({ id })),
    rotateViewKey: (id: string, opts: RequestOptions) =>
        rotateRoute.POST(request('POST', `/api/stores/${id}/rotate-view-key`, opts), ctx({ id })),
    provision: (id: string, opts: RequestOptions) =>
        provisionRoute.POST(request('POST', `/api/stores/${id}/provision`, opts), ctx({ id })),
    releaseStore: (id: string, opts: RequestOptions) =>
        releaseRoute.POST(request('POST', `/api/stores/${id}/release`, opts), ctx({ id })),
    patchStore: (id: string, opts: RequestOptions) =>
        storeRoute.PATCH(request('PATCH', `/api/stores/${id}`, opts), ctx({ id })),
    myStores: (opts: RequestOptions) => myStoresRoute.GET(request('GET', '/api/me/stores', opts)),
    auth: (authPath: string, opts: RequestOptions) =>
        authRoute.POST(request('POST', `/api/auth/${authPath}`, opts)),
    listBeans: (id: string, opts: RequestOptions) =>
        beansRoute.GET(request('GET', `/api/stores/${id}/beans`, opts), ctx({ id })),
    createBean: (id: string, opts: RequestOptions) =>
        beansRoute.POST(request('POST', `/api/stores/${id}/beans`, opts), ctx({ id })),
    patchBean: (id: string, beanId: string, opts: RequestOptions) =>
        beanRoute.PATCH(
            request('PATCH', `/api/stores/${id}/beans/${beanId}`, opts),
            ctx({ id, beanId }),
        ),
    deleteBean: (id: string, beanId: string, opts: RequestOptions) =>
        beanRoute.DELETE(
            request('DELETE', `/api/stores/${id}/beans/${beanId}`, opts),
            ctx({ id, beanId }),
        ),
    activateBean: (id: string, beanId: string, opts: RequestOptions) =>
        beanActivateRoute.POST(
            request('POST', `/api/stores/${id}/beans/${beanId}/activate`, opts),
            ctx({ id, beanId }),
        ),
    getConfig: (id: string, opts: RequestOptions) =>
        configRoute.GET(request('GET', `/api/stores/${id}/config`, opts), ctx({ id })),
    postBrews: (id: string, opts: RequestOptions) =>
        brewsRoute.POST(request('POST', `/api/stores/${id}/brews`, opts), ctx({ id })),
};

// The session cookie(s) a Better Auth response sets, folded into a `cookie`
// request header for subsequent calls.
function cookieFrom(response: Response): string {
    return response.headers
        .getSetCookie()
        .map((entry) => entry.split(';')[0])
        .join('; ');
}

let userCounter = 0;

// Signs up a fresh account through the real Better Auth handler and returns
// the session cookie header value.
export async function signUp(email?: string, password = 'grinder-test-pass'): Promise<string> {
    const address = email ?? `user${++userCounter}@test.local`;
    const response = await api.auth('sign-up/email', {
        body: { email: address, password, name: address.split('@')[0] },
    });
    if (response.status !== 200) {
        throw new Error(`sign-up failed: ${response.status} ${await response.text()}`);
    }
    const cookie = cookieFrom(response);
    if (!cookie) throw new Error('sign-up set no session cookie');
    return cookie;
}

export interface StoreCredentials {
    store_id: string;
    upload_key: string;
    view_key: string;
    device_id: string;
    cookie: string;
}

let deviceCounter = 0;

// A distinct grinder per call, in the firmware's format (12 hex digits).
export function newDeviceId(): string {
    return (++deviceCounter).toString(16).padStart(12, '0');
}

// Creates a store for a signed-in account (a fresh one unless a cookie is
// passed), mirroring the browser flow: sign in, read the grinder's id over
// BLE, create, provision over BLE.
export async function newStore(cookie?: string, deviceId?: string): Promise<StoreCredentials> {
    const owner = cookie ?? (await signUp());
    const device = deviceId ?? newDeviceId();
    const response = await api.createStore({ cookie: owner, body: { device_id: device } });
    if (response.status !== 201) throw new Error(`store create failed: ${response.status}`);
    const created = (await response.json()) as Omit<StoreCredentials, 'cookie' | 'device_id'>;
    return { ...created, device_id: device, cookie: owner };
}
