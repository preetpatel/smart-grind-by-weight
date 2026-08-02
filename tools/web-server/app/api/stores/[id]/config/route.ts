// Device config: the active bean and the current grind advice. Fetched by the
// firmware during its cloud-sync window (upload key) and by the dashboard for
// the overview callout. The firmware parses this by scanning for flat keys —
// keep the payload shallow.
import { deviceConfig } from '@/lib/advice';
import { authStore } from '@/lib/auth';
import { withCors } from '@/lib/cors';
import { getDb } from '@/lib/db';
import { handleErrors, json } from '@/lib/http';

export { OPTIONS } from '@/lib/cors';

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context): Promise<Response> {
    return withCors(
        await handleErrors(async () => {
            const { id } = await params;
            const db = await getDb();
            const { store } = await authStore(db, request, id, 'read');
            return json(await deviceConfig(db, store));
        }),
    );
}
