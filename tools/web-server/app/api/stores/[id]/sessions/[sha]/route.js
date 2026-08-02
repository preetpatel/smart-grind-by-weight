import { and, eq } from 'drizzle-orm';
import { getDb } from '../../../../../../lib/db.js';
import { handleErrors, ApiError } from '../../../../../../lib/http.js';
import { withCors } from '../../../../../../lib/cors.js';
import { authStore } from '../../../../../../lib/auth.js';
import { sessions } from '../../../../../../lib/schema.js';

export { OPTIONS } from '../../../../../../lib/cors.js';

// Raw session blob by content hash — the deep-dive views and the Python tool
// fetch these one at a time and parse client-side (blob-as-truth model).
export async function GET(request, { params }) {
    return withCors(await handleErrors(async () => {
        const { id, sha } = await params;
        const db = await getDb();
        await authStore(db, request, id, 'read');
        const rows = await db.select({ blob: sessions.blob }).from(sessions)
            .where(and(eq(sessions.storeId, id), eq(sessions.sha256, sha)));
        if (!rows.length) throw new ApiError(404, 'session not found');
        return new Response(new Uint8Array(rows[0].blob), {
            status: 200,
            headers: {
                'Content-Type': 'application/octet-stream',
                'Cache-Control': 'private, max-age=31536000, immutable',
            },
        });
    }));
}
