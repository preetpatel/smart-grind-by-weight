import { eq } from 'drizzle-orm';
import { authStore } from '@/lib/auth';
import { withCors } from '@/lib/cors';
import { getDb } from '@/lib/db';
import { handleErrors, json } from '@/lib/http';
import { hashKey, newViewKey } from '@/lib/keys';
import { stores } from '@/lib/schema';

export { OPTIONS } from '@/lib/cors';

type Context = { params: Promise<{ id: string }> };

// Leak recovery for the shareable view key: mints a replacement and invalidates
// the old one. The flasher writes the fresh key back to the device so future
// BLE claims hand out the new key. Upload-key auth only.
export async function POST(request: Request, { params }: Context): Promise<Response> {
    return withCors(
        await handleErrors(async () => {
            const { id } = await params;
            const db = await getDb();
            await authStore(db, request, id, 'write');
            const viewKey = newViewKey();
            await db
                .update(stores)
                .set({ viewKeyHash: hashKey(viewKey) })
                .where(eq(stores.id, id));
            return json({ view_key: viewKey });
        }),
    );
}
