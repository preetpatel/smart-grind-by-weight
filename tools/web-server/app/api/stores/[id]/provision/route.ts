import { eq } from 'drizzle-orm';
import { assertSameOrigin, authOwner } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { handleErrors, json } from '@/lib/http';
import { hashKey, newUploadKey } from '@/lib/keys';
import { stores } from '@/lib/schema';

type Context = { params: Promise<{ id: string }> };

// Device provisioning: mints a fresh upload key (invalidating the previous
// device credential) and hands the full credential set to the owner's browser
// for the BLE NVS write. Rotate-on-provision keeps the server hash-only for
// upload keys — a DB dump never leaks a write credential — while still
// letting any signed-in browser provision a device (docs/CLOUD_SYNC.md).
export async function POST(request: Request, { params }: Context): Promise<Response> {
    return handleErrors(async () => {
        assertSameOrigin(request);
        const { id } = await params;
        const db = await getDb();
        const { store } = await authOwner(db, request, id);
        const uploadKey = newUploadKey();
        await db
            .update(stores)
            .set({ uploadKeyHash: hashKey(uploadKey) })
            .where(eq(stores.id, id));
        return json({ store_id: store.id, upload_key: uploadKey, view_key: store.viewKey });
    });
}
