import { eq } from 'drizzle-orm';
import { assertSameOrigin, authOwner } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { normalizeDeviceId } from '@/lib/device-id';
import { ApiError, handleErrors, json } from '@/lib/http';
import { hashKey, newUploadKey } from '@/lib/keys';
import { stores } from '@/lib/schema';

type Context = { params: Promise<{ id: string }> };

// Device provisioning: mints a fresh upload key (invalidating the previous
// device credential) and hands the full credential set to the owner's browser
// for the BLE NVS write. Rotate-on-provision keeps the server hash-only for
// upload keys — a DB dump never leaks a write credential — while still
// letting any signed-in browser provision a device (docs/CLOUD_SYNC.md).
//
// An optional device_id binds a store that has none yet, which is how stores
// that predate the binding (or were released) adopt a grinder. Pointing a
// second grinder at an already-bound store is refused here rather than
// discovered later at ingest.
export async function POST(request: Request, { params }: Context): Promise<Response> {
    return handleErrors(async () => {
        assertSameOrigin(request);
        const { id } = await params;
        const db = await getDb();
        const { store } = await authOwner(db, request, id);

        let deviceId: string | null = null;
        try {
            const body = (await request.json()) as { device_id?: unknown };
            deviceId = normalizeDeviceId(body.device_id);
        } catch {
            // No body is fine: a plain key rotation.
        }

        if (deviceId && store.deviceId && deviceId !== store.deviceId) {
            throw new ApiError(
                409,
                'this store belongs to another grinder',
                'store_bound_other_device',
            );
        }
        const binding = deviceId && !store.deviceId ? deviceId : null;
        if (binding) {
            const [other] = await db.select().from(stores).where(eq(stores.deviceId, binding));
            if (other) {
                throw new ApiError(
                    409,
                    'this grinder already has a store',
                    'device_bound_elsewhere',
                );
            }
        }

        const uploadKey = newUploadKey();
        await db
            .update(stores)
            .set({ uploadKeyHash: hashKey(uploadKey), ...(binding ? { deviceId: binding } : {}) })
            .where(eq(stores.id, id));
        return json({
            store_id: store.id,
            upload_key: uploadKey,
            view_key: store.viewKey,
            device_id: binding ?? store.deviceId,
        });
    });
}
