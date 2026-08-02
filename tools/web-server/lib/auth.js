import { timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { ApiError, bearerKey } from './http.js';
import { hashKey } from './keys.js';
import { stores } from './schema.js';

function hashesEqual(a, b) {
    const bufA = Buffer.from(a, 'hex');
    const bufB = Buffer.from(b, 'hex');
    return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

// Loads the store and authenticates the request's bearer key.
// role 'read': view or upload key. role 'write': upload key only —
// upload_key is a strict superset of view_key everywhere (docs/CLOUD_SYNC.md).
// Returns { store, role } where role is what the presented key grants.
export async function authStore(db, request, storeId, role) {
    const key = bearerKey(request);
    if (!key) throw new ApiError(401, 'missing bearer key');

    const rows = await db.select().from(stores).where(eq(stores.id, storeId));
    if (!rows.length) throw new ApiError(404, 'store not found');
    const store = rows[0];

    const presented = hashKey(key);
    const isUpload = hashesEqual(presented, store.uploadKeyHash);
    const isView = !isUpload && hashesEqual(presented, store.viewKeyHash);

    if (!isUpload && !isView) throw new ApiError(403, 'invalid key');
    if (role === 'write' && !isUpload) throw new ApiError(403, 'write access requires the upload key');
    return { store, role: isUpload ? 'write' : 'read' };
}
