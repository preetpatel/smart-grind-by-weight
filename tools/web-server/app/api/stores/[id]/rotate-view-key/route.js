import { eq } from 'drizzle-orm';
import { getDb } from '../../../../../lib/db.js';
import { json, handleErrors } from '../../../../../lib/http.js';
import { withCors } from '../../../../../lib/cors.js';
import { authStore } from '../../../../../lib/auth.js';
import { newViewKey, hashKey } from '../../../../../lib/keys.js';
import { stores } from '../../../../../lib/schema.js';

export { OPTIONS } from '../../../../../lib/cors.js';

// Leak recovery for the shareable view key: mints a replacement and invalidates
// the old one. The flasher writes the fresh key back to the device so future
// BLE claims hand out the new key. Upload-key auth only.
export async function POST(request, { params }) {
    return withCors(await handleErrors(async () => {
        const { id } = await params;
        const db = await getDb();
        await authStore(db, request, id, 'write');
        const viewKey = newViewKey();
        await db.update(stores).set({ viewKeyHash: hashKey(viewKey) }).where(eq(stores.id, id));
        return json({ view_key: viewKey });
    }));
}
