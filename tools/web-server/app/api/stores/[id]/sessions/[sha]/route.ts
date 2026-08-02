import { and, eq } from 'drizzle-orm';
import { assertSameOrigin, authOwner, authStore } from '@/lib/auth';
import { withCors } from '@/lib/cors';
import { getDb } from '@/lib/db';
import { ApiError, handleErrors, json } from '@/lib/http';
import { deletedSessions, sessions } from '@/lib/schema';

export { OPTIONS } from '@/lib/cors';

type Context = { params: Promise<{ id: string; sha: string }> };

// Raw session blob by content hash — the deep-dive views and the Python tool
// fetch these one at a time and parse client-side (blob-as-truth model).
export async function GET(request: Request, { params }: Context): Promise<Response> {
    return withCors(
        await handleErrors(async () => {
            const { id, sha } = await params;
            const db = await getDb();
            await authStore(db, request, id, 'read');
            const rows = await db
                .select({ blob: sessions.blob })
                .from(sessions)
                .where(and(eq(sessions.storeId, id), eq(sessions.sha256, sha)));
            const row = rows[0];
            if (!row) throw new ApiError(404, 'session not found');
            return new Response(new Uint8Array(row.blob), {
                status: 200,
                headers: {
                    'Content-Type': 'application/octet-stream',
                    'Cache-Control': 'private, max-age=31536000, immutable',
                },
            });
        }),
    );
}

// Deleting a grind for good. The manifest handshake is stateless — it asks the
// server what it lacks — so removing the row alone would simply invite the
// grinder to upload it again on the next sync. A tombstone records the
// identity the device uses (session_id + timestamp) as well as the content
// hash, and both the manifest and ingest consult it. Owner session only.
export async function DELETE(request: Request, { params }: Context): Promise<Response> {
    return withCors(
        await handleErrors(async () => {
            assertSameOrigin(request);
            const { id, sha } = await params;
            const db = await getDb();
            await authOwner(db, request, id);

            const rows = await db
                .select({
                    sessionId: sessions.sessionId,
                    sessionTimestamp: sessions.sessionTimestamp,
                })
                .from(sessions)
                .where(and(eq(sessions.storeId, id), eq(sessions.sha256, sha)));
            const row = rows[0];
            if (!row) throw new ApiError(404, 'session not found');

            await db
                .insert(deletedSessions)
                .values({
                    storeId: id,
                    sha256: sha,
                    sessionId: row.sessionId,
                    sessionTimestamp: row.sessionTimestamp,
                })
                .onConflictDoNothing();
            await db
                .delete(sessions)
                .where(and(eq(sessions.storeId, id), eq(sessions.sha256, sha)));

            return json({ deleted: sha });
        }),
    );
}
