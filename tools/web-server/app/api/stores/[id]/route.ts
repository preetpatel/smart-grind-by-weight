import { count, eq } from 'drizzle-orm';
import { assertSameOrigin, authOwner, authStore } from '@/lib/auth';
import { config } from '@/lib/config';
import { withCors } from '@/lib/cors';
import { getDb } from '@/lib/db';
import { ApiError, handleErrors, json } from '@/lib/http';
import { sessions, stores } from '@/lib/schema';

export { OPTIONS } from '@/lib/cors';

type Context = { params: Promise<{ id: string }> };

// Store metadata for the dashboard header / quota banner. Readable with a
// key (share links are cross-origin, hence CORS) or the owner's session.
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
                session_count: rows[0]?.n ?? 0,
                session_quota: config.sessionQuota,
                role,
            });
        }),
    );
}

// Renames the store. Owner session only.
export async function PATCH(request: Request, { params }: Context): Promise<Response> {
    return handleErrors(async () => {
        assertSameOrigin(request);
        const { id } = await params;
        const db = await getDb();
        await authOwner(db, request, id);
        let name: unknown;
        try {
            const body = (await request.json()) as { name?: unknown };
            name = body.name;
        } catch {
            throw new ApiError(400, 'body must be JSON');
        }
        if (typeof name !== 'string' || !name.trim()) {
            throw new ApiError(400, 'name must be a non-empty string');
        }
        await db
            .update(stores)
            .set({ name: name.trim().slice(0, 80) })
            .where(eq(stores.id, id));
        return json({ renamed: true });
    });
}

// Deletes the store and everything in it. Owner session only — keys never
// grant store management.
export async function DELETE(request: Request, { params }: Context): Promise<Response> {
    return handleErrors(async () => {
        assertSameOrigin(request);
        const { id } = await params;
        const db = await getDb();
        await authOwner(db, request, id);
        await db.delete(stores).where(eq(stores.id, id));
        return json({ deleted: true });
    });
}
