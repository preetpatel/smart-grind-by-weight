import { eq } from 'drizzle-orm';
import { assertSameOrigin, authOwner } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { handleErrors, json } from '@/lib/http';
import { newViewKey } from '@/lib/keys';
import { stores } from '@/lib/schema';

type Context = { params: Promise<{ id: string }> };

// Leak recovery for the shareable view key: mints a replacement and
// invalidates the old one (old share links and un-reprovisioned devices lose
// read access until updated). Owner session only.
export async function POST(request: Request, { params }: Context): Promise<Response> {
    return handleErrors(async () => {
        assertSameOrigin(request);
        const { id } = await params;
        const db = await getDb();
        await authOwner(db, request, id);
        const viewKey = newViewKey();
        await db.update(stores).set({ viewKey }).where(eq(stores.id, id));
        return json({ view_key: viewKey });
    });
}
