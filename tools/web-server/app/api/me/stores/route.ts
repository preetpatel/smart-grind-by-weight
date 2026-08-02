import { count, desc, eq, max } from 'drizzle-orm';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { handleErrors, json } from '@/lib/http';
import { sessions, stores } from '@/lib/schema';

// The signed-in account's stores, newest first, with enough metadata for the
// analytics source picker and the account page. view_key is included (it is
// the semi-public share credential); the upload key never appears — fresh
// copies come only from POST /api/stores/[id]/provision.
export async function GET(request: Request): Promise<Response> {
    return handleErrors(async () => {
        const user = await requireUser(request);
        const db = await getDb();
        const rows = await db
            .select({
                id: stores.id,
                name: stores.name,
                viewKey: stores.viewKey,
                deviceId: stores.deviceId,
                createdAt: stores.createdAt,
                sessionCount: count(sessions.id),
                lastReceivedAt: max(sessions.receivedAt),
            })
            .from(stores)
            .leftJoin(sessions, eq(sessions.storeId, stores.id))
            .where(eq(stores.ownerId, user.id))
            .groupBy(stores.id)
            .orderBy(desc(stores.createdAt));
        return json({
            stores: rows.map((row) => ({
                store_id: row.id,
                name: row.name,
                view_key: row.viewKey,
                device_id: row.deviceId,
                created_at: row.createdAt,
                session_count: row.sessionCount,
                last_received_at: row.lastReceivedAt,
            })),
        });
    });
}
