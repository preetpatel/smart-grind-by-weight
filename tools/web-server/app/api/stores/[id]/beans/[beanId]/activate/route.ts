// Make one bean the active bag. The dashboard follows this call with a BLE
// push of the same values, so the server is written first and stays the
// source of truth both channels deliver.
import { and, eq } from 'drizzle-orm';
import { assertSameOrigin, authOwner } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { ApiError, handleErrors, json } from '@/lib/http';
import { beans, stores } from '@/lib/schema';

type Context = { params: Promise<{ id: string; beanId: string }> };

export async function POST(request: Request, { params }: Context): Promise<Response> {
    return handleErrors(async () => {
        assertSameOrigin(request);
        const { id, beanId } = await params;
        const db = await getDb();
        await authOwner(db, request, id);

        const rows = await db
            .select({ id: beans.id })
            .from(beans)
            .where(and(eq(beans.storeId, id), eq(beans.id, beanId)));
        if (!rows.length) throw new ApiError(404, 'bean not found');

        // Activating implies the bag is back in the hopper.
        await db
            .update(beans)
            .set({ archivedAt: null, updatedAt: new Date() })
            .where(and(eq(beans.storeId, id), eq(beans.id, beanId)));
        await db.update(stores).set({ activeBeanId: beanId }).where(eq(stores.id, id));
        return json({ active_bean_id: beanId });
    });
}
