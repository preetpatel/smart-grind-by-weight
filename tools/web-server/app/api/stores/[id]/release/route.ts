import { eq } from 'drizzle-orm';
import { assertSameOrigin, authOwner } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { handleErrors, json } from '@/lib/http';
import { stores } from '@/lib/schema';

type Context = { params: Promise<{ id: string }> };

// Unbinds the grinder, leaving the store and every session in it intact. The
// deliberate way to hand a grinder on, or to point it at a different store:
// the next account to provision it starts fresh, and this store becomes a
// read-only archive its owner can still browse, rename or delete.
export async function POST(request: Request, { params }: Context): Promise<Response> {
    return handleErrors(async () => {
        assertSameOrigin(request);
        const { id } = await params;
        const db = await getDb();
        await authOwner(db, request, id);
        await db.update(stores).set({ deviceId: null }).where(eq(stores.id, id));
        return json({ released: true });
    });
}
