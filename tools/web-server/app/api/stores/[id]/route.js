import { count, eq } from 'drizzle-orm';
import { getDb } from '../../../../lib/db.js';
import { json, handleErrors } from '../../../../lib/http.js';
import { withCors } from '../../../../lib/cors.js';
import { authStore } from '../../../../lib/auth.js';
import { config } from '../../../../lib/config.js';
import { stores, sessions } from '../../../../lib/schema.js';

export { OPTIONS } from '../../../../lib/cors.js';

// Store metadata for the dashboard header / quota banner.
export async function GET(request, { params }) {
    return withCors(await handleErrors(async () => {
        const { id } = await params;
        const db = await getDb();
        const { store, role } = await authStore(db, request, id, 'read');
        const [{ n }] = await db.select({ n: count() }).from(sessions)
            .where(eq(sessions.storeId, id));
        return json({
            store_id: store.id,
            name: store.name,
            created_at: store.createdAt,
            provisional: !store.firstUploadAt,
            session_count: n,
            session_quota: config.sessionQuota,
            role,
        });
    }));
}

// Deletes the store and everything in it. Upload key only — physical
// possession of the grinder (or the provisioning browser) is the auth.
export async function DELETE(request, { params }) {
    return withCors(await handleErrors(async () => {
        const { id } = await params;
        const db = await getDb();
        await authStore(db, request, id, 'write');
        await db.delete(stores).where(eq(stores.id, id));
        return json({ deleted: true });
    }));
}
