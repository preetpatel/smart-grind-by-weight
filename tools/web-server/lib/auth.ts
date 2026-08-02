import { eq } from 'drizzle-orm';
import { getSessionUser, type SessionUser } from './auth-server';
import type { Db } from './db';
import { deviceIdHeader } from './device-id';
import { ApiError, bearerKey } from './http';
import { hashKey, keysEqual } from './keys';
import { type Store, stores } from './schema';

export type Role = 'read' | 'write';

// One store, one grinder. A device holding the right upload key but wearing a
// different identity is a mis-provisioned second grinder, so its uploads are
// refused rather than silently mixed into someone else's history. Only
// key-authed requests are checked: a browser backfill rides the owner's
// cookie and its local records carry no per-record device id. Firmware that
// predates the header passes.
function assertDeviceMatches(request: Request, store: Store): void {
    if (!store.deviceId) return;
    const claimed = deviceIdHeader(request);
    if (claimed && claimed !== store.deviceId) {
        throw new ApiError(403, 'this store belongs to another grinder', 'device_mismatch');
    }
}

// Loads the store and authorizes the request against it, session first:
// the store owner's session cookie grants write; otherwise fall back to the
// bearer key (upload key = write, view key = read; upload ⊇ view everywhere,
// docs/CLOUD_SYNC.md). Returns the store and what the request actually got.
export async function authStore(
    db: Db,
    request: Request,
    storeId: string,
    role: Role,
): Promise<{ store: Store; role: Role }> {
    const [store] = await db.select().from(stores).where(eq(stores.id, storeId));
    if (!store) throw new ApiError(404, 'store not found');

    const user = await getSessionUser(request);
    if (user && user.id === store.ownerId) return { store, role: 'write' };

    const key = bearerKey(request);
    if (!key) throw new ApiError(401, 'sign in or present a bearer key');

    const isUpload = keysEqual(hashKey(key), store.uploadKeyHash);
    const isView = !isUpload && keysEqual(key, store.viewKey);

    if (!isUpload && !isView) throw new ApiError(403, 'invalid key');
    if (role === 'write' && !isUpload) {
        throw new ApiError(403, 'write access requires the upload key');
    }
    if (isUpload) assertDeviceMatches(request, store);
    return { store, role: isUpload ? 'write' : 'read' };
}

// Owner-only operations (delete, rename, provision, rotate keys): the session
// cookie is the only accepted credential — keys never grant store management.
export async function authOwner(
    db: Db,
    request: Request,
    storeId: string,
): Promise<{ store: Store; user: SessionUser }> {
    const user = await requireUser(request);
    const [store] = await db.select().from(stores).where(eq(stores.id, storeId));
    if (!store) throw new ApiError(404, 'store not found');
    if (store.ownerId !== user.id) throw new ApiError(403, 'not your store');
    return { store, user };
}

export async function requireUser(request: Request): Promise<SessionUser> {
    const user = await getSessionUser(request);
    if (!user) throw new ApiError(401, 'sign in first');
    return user;
}

// CSRF guard for session-authed mutations outside Better Auth's own routes.
// Browsers always send Origin on cross-site state-changing requests; a
// mismatch means the cookie was riding along on someone else's page. Requests
// without an Origin header (device firmware, curl, tests) pass — they carry
// no ambient credentials to protect.
export function assertSameOrigin(request: Request): void {
    const origin = request.headers.get('origin');
    if (!origin) return;
    if (origin !== new URL(request.url).origin) {
        throw new ApiError(403, 'cross-origin request rejected');
    }
}
