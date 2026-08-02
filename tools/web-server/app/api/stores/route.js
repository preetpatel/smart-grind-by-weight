import { and, count, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { getDb } from '../../../lib/db.js';
import { json, handleErrors, clientIp, ApiError } from '../../../lib/http.js';
import { withCors } from '../../../lib/cors.js';
import { newStoreId, newUploadKey, newViewKey, hashKey } from '../../../lib/keys.js';
import { config } from '../../../lib/config.js';
import { stores } from '../../../lib/schema.js';

export { OPTIONS } from '../../../lib/cors.js';

// Creates a store. Public by design (the flasher is public JS — possession of
// a grinder gates *claiming* keys, not creating stores), so stores are
// provisional until a device uploads real data, and creation is IP-limited.
export async function POST(request) {
    return withCors(await handleErrors(async () => {
        const db = await getDb();
        const ip = clientIp(request);

        // Opportunistic GC: expired provisional stores die when new ones arrive.
        await db.delete(stores).where(and(
            isNull(stores.firstUploadAt),
            lt(stores.createdAt, sql`now() - make_interval(hours => ${config.provisionalTtlHours})`),
        ));

        const [{ n }] = await db.select({ n: count() }).from(stores)
            .where(and(
                eq(stores.createdIp, ip),
                gt(stores.createdAt, sql`now() - interval '24 hours'`),
            ));
        if (n >= config.storesPerIpPerDay) {
            throw new ApiError(429, 'store creation limit reached; try again later');
        }

        let name = null;
        try {
            const body = await request.json();
            if (typeof body?.name === 'string') name = body.name.slice(0, 80);
        } catch {
            // Empty or non-JSON body is fine.
        }

        const storeId = newStoreId();
        const uploadKey = newUploadKey();
        const viewKey = newViewKey();
        await db.insert(stores).values({
            id: storeId,
            uploadKeyHash: hashKey(uploadKey),
            viewKeyHash: hashKey(viewKey),
            name,
            createdIp: ip,
        });

        // The only time either key ever leaves the server in plaintext.
        return json({ store_id: storeId, upload_key: uploadKey, view_key: viewKey }, 201);
    }));
}
