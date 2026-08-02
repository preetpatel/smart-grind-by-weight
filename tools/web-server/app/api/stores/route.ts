import { count, eq } from 'drizzle-orm';
import { assertSameOrigin, requireUser } from '@/lib/auth';
import { config } from '@/lib/config';
import { getDb } from '@/lib/db';
import { ApiError, handleErrors, json } from '@/lib/http';
import { hashKey, newStoreId, newUploadKey, newViewKey } from '@/lib/keys';
import { stores } from '@/lib/schema';

// Creates a store owned by the signed-in account (docs/CLOUD_SYNC.md "Auth
// model"). Session-authed and same-origin — no CORS here, unlike the
// key-authed device/share routes.
export async function POST(request: Request): Promise<Response> {
    return handleErrors(async () => {
        assertSameOrigin(request);
        const user = await requireUser(request);
        const db = await getDb();

        const rows = await db
            .select({ n: count() })
            .from(stores)
            .where(eq(stores.ownerId, user.id));
        if ((rows[0]?.n ?? 0) >= config.storesPerUser) {
            throw new ApiError(429, `account already has ${config.storesPerUser} stores`);
        }

        let name: string | null = null;
        try {
            const body: unknown = await request.json();
            if (typeof body === 'object' && body !== null && 'name' in body) {
                const candidate = (body as { name: unknown }).name;
                if (typeof candidate === 'string') name = candidate.slice(0, 80);
            }
        } catch {
            // Empty or non-JSON body is fine.
        }

        const storeId = newStoreId();
        const uploadKey = newUploadKey();
        const viewKey = newViewKey();
        await db.insert(stores).values({
            id: storeId,
            ownerId: user.id,
            uploadKeyHash: hashKey(uploadKey),
            viewKey,
            name,
        });

        // The only time this upload key exists in plaintext outside the
        // device: the caller writes it over BLE now. Later re-provisioning
        // mints a replacement via POST /api/stores/[id]/provision.
        return json({ store_id: storeId, upload_key: uploadKey, view_key: viewKey }, 201);
    });
}
