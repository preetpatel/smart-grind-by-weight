import { count, eq } from 'drizzle-orm';
import { authStore } from '@/lib/auth';
import { config } from '@/lib/config';
import { withCors } from '@/lib/cors';
import { getDb } from '@/lib/db';
import { handleErrors, json } from '@/lib/http';
import { sessions, stores } from '@/lib/schema';

export { OPTIONS } from '@/lib/cors';

type Context = { params: Promise<{ id: string }> };

// Store metadata for the dashboard header / quota banner.
export async function GET(request: Request, { params }: Context): Promise<Response> {
    return withCors(
        await handleErrors(async () => {
            const { id } = await params;
            const db = await getDb();
            const { store, role } = await authStore(db, request, id, 'read');
            const rows = await db
                .select({ n: count() })
                .from(sessions)
                .where(eq(sessions.storeId, id));
            return json({
                store_id: store.id,
                name: store.name,
                created_at: store.createdAt,
                provisional: !store.firstUploadAt,
                session_count: rows[0]?.n ?? 0,
                session_quota: config.sessionQuota,
                role,
            });
        }),
    );
}

// Deletes the store and everything in it. Upload key only — physical
// possession of the grinder (or the provisioning browser) is the auth.
export async function DELETE(request: Request, { params }: Context): Promise<Response> {
    return withCors(
        await handleErrors(async () => {
            const { id } = await params;
            const db = await getDb();
            await authStore(db, request, id, 'write');
            await db.delete(stores).where(eq(stores.id, id));
            return json({ deleted: true });
        }),
    );
}
