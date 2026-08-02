import { timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from './db';
import { ApiError, bearerKey } from './http';
import { hashKey } from './keys';
import { type Store, stores } from './schema';

export type Role = 'read' | 'write';

function hashesEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'hex');
    const bufB = Buffer.from(b, 'hex');
    return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

// Loads the store and authenticates the request's bearer key.
// role 'read': view or upload key. role 'write': upload key only —
// upload_key is a strict superset of view_key everywhere (docs/CLOUD_SYNC.md).
// Returns the store and what the presented key actually grants.
export async function authStore(
    db: Db,
    request: Request,
    storeId: string,
    role: Role,
): Promise<{ store: Store; role: Role }> {
    const key = bearerKey(request);
    if (!key) throw new ApiError(401, 'missing bearer key');

    const [store] = await db.select().from(stores).where(eq(stores.id, storeId));
    if (!store) throw new ApiError(404, 'store not found');

    const presented = hashKey(key);
    const isUpload = hashesEqual(presented, store.uploadKeyHash);
    const isView = !isUpload && hashesEqual(presented, store.viewKeyHash);

    if (!isUpload && !isView) throw new ApiError(403, 'invalid key');
    if (role === 'write' && !isUpload) {
        throw new ApiError(403, 'write access requires the upload key');
    }
    return { store, role: isUpload ? 'write' : 'read' };
}
