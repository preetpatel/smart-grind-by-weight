import { and, eq } from 'drizzle-orm';
import { authStore } from '@/lib/auth';
import { withCors } from '@/lib/cors';
import { getDb } from '@/lib/db';
import { ApiError, handleErrors } from '@/lib/http';
import { sessions } from '@/lib/schema';

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
