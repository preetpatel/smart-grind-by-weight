import { and, count, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { config } from '@/lib/config';
import { withCors } from '@/lib/cors';
import { getDb } from '@/lib/db';
import { ApiError, clientIp, handleErrors, json } from '@/lib/http';
import { hashKey, newStoreId, newUploadKey, newViewKey } from '@/lib/keys';
import { stores } from '@/lib/schema';

export { OPTIONS } from '@/lib/cors';

// Creates a store. Public by design (the flasher is public JS — possession of
// a grinder gates *claiming* keys, not creating stores), so stores are
// provisional until a device uploads real data, and creation is IP-limited.
export async function POST(request: Request): Promise<Response> {
    return withCors(
        await handleErrors(async () => {
            const db = await getDb();
            const ip = clientIp(request);

            // Opportunistic GC: expired provisional stores die when new ones arrive.
            await db
                .delete(stores)
                .where(
                    and(
                        isNull(stores.firstUploadAt),
                        lt(
                            stores.createdAt,
                            sql`now() - make_interval(hours => ${config.provisionalTtlHours})`,
                        ),
                    ),
                );

            const rows = await db
                .select({ n: count() })
                .from(stores)
                .where(
                    and(
                        eq(stores.createdIp, ip),
                        gt(stores.createdAt, sql`now() - interval '24 hours'`),
                    ),
                );
            if ((rows[0]?.n ?? 0) >= config.storesPerIpPerDay) {
                throw new ApiError(429, 'store creation limit reached; try again later');
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
                uploadKeyHash: hashKey(uploadKey),
                viewKeyHash: hashKey(viewKey),
                name,
                createdIp: ip,
            });

            // The only time either key ever leaves the server in plaintext.
            return json({ store_id: storeId, upload_key: uploadKey, view_key: viewKey }, 201);
        }),
    );
}
