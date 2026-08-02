import { count, eq } from 'drizzle-orm';
import { assertSameOrigin, requireUser } from '@/lib/auth';
import { config } from '@/lib/config';
import { getDb } from '@/lib/db';
import { normalizeDeviceId } from '@/lib/device-id';
import { ApiError, handleErrors, json } from '@/lib/http';
import { hashKey, keysEqual, newStoreId, newUploadKey, newViewKey } from '@/lib/keys';
import { type Store, stores } from '@/lib/schema';

interface CreateBody {
    deviceId: string;
    name: string | null;
    proof: { storeId: string; viewKey: string } | null;
}

function parseBody(raw: unknown): CreateBody {
    const body = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const deviceId = normalizeDeviceId(body.device_id);
    if (!deviceId) throw new ApiError(400, 'device_id must be the grinder id (12 hex digits)');

    const proofValue = body.proof;
    let proof: CreateBody['proof'] = null;
    if (typeof proofValue === 'object' && proofValue !== null) {
        const { store_id: storeId, view_key: viewKey } = proofValue as Record<string, unknown>;
        if (typeof storeId === 'string' && typeof viewKey === 'string') {
            proof = { storeId, viewKey };
        }
    }
    return {
        deviceId,
        name: typeof body.name === 'string' ? body.name.slice(0, 80) : null,
        proof,
    };
}

// Possession is what lets someone claim a grinder that is already registered
// elsewhere: the store_id + view_key pair only comes off the grinder itself,
// over BLE (docs/CLOUD_SYNC.md "Auth model").
function provesPossession(store: Store, proof: CreateBody['proof']): boolean {
    return proof !== null && proof.storeId === store.id && keysEqual(proof.viewKey, store.viewKey);
}

// One grinder, one store. The device id decides which store you get, so the
// same grinder provisioned from a second browser, after a Forget Sync, or on
// a factory-reset device lands back on its own history instead of minting a
// duplicate. Session-authed and same-origin — no CORS here, unlike the
// key-authed device/share routes.
export async function POST(request: Request): Promise<Response> {
    return handleErrors(async () => {
        assertSameOrigin(request);
        const user = await requireUser(request);
        const db = await getDb();

        let raw: unknown;
        try {
            raw = await request.json();
        } catch {
            throw new ApiError(400, 'body must be JSON');
        }
        const { deviceId, name, proof } = parseBody(raw);

        const [bound] = await db.select().from(stores).where(eq(stores.deviceId, deviceId));

        // Already yours: hand back the same store with a fresh device
        // credential. Creating and provisioning are the same act here.
        if (bound && bound.ownerId === user.id) {
            const uploadKey = newUploadKey();
            await db
                .update(stores)
                .set({ uploadKeyHash: hashKey(uploadKey) })
                .where(eq(stores.id, bound.id));
            return json({
                store_id: bound.id,
                upload_key: uploadKey,
                view_key: bound.viewKey,
                status: 'reused',
            });
        }

        // Someone else's: whoever holds the grinder may take it over, but they
        // get an empty store — the previous owner keeps every grind, in a
        // store that is simply no longer bound to a device.
        if (bound) {
            if (!provesPossession(bound, proof)) {
                throw new ApiError(
                    409,
                    'this grinder is registered to another account',
                    'device_bound_elsewhere',
                );
            }
            await db.update(stores).set({ deviceId: null }).where(eq(stores.id, bound.id));
        }

        const rows = await db
            .select({ n: count() })
            .from(stores)
            .where(eq(stores.ownerId, user.id));
        if ((rows[0]?.n ?? 0) >= config.storesPerUser) {
            throw new ApiError(429, `account already has ${config.storesPerUser} stores`);
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
            deviceId,
        });

        // The only time this upload key exists in plaintext outside the
        // device: the caller writes it over BLE now. Later re-provisioning
        // mints a replacement via POST /api/stores/[id]/provision.
        return json(
            {
                store_id: storeId,
                upload_key: uploadKey,
                view_key: viewKey,
                status: bound ? 'claimed' : 'created',
            },
            201,
        );
    });
}
