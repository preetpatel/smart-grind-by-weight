import { desc, eq } from 'drizzle-orm';
import { getDb } from '../../../../../lib/db.js';
import { json, handleErrors, ApiError } from '../../../../../lib/http.js';
import { withCors } from '../../../../../lib/cors.js';
import { authStore } from '../../../../../lib/auth.js';
import { config } from '../../../../../lib/config.js';
import { snapshots } from '../../../../../lib/schema.js';

export { OPTIONS } from '../../../../../lib/cors.js';

// Device health / lifetime-stats snapshots (docs/CLOUD_SYNC.md): timestamped
// observations POSTed after each successful sync. Kept as-is — the history is
// the value (noise creep, calibration drift, error rate vs firmware version).
export async function POST(request, { params }) {
    return withCors(await handleErrors(async () => {
        const { id } = await params;
        const db = await getDb();
        await authStore(db, request, id, 'write');

        const text = await request.text();
        if (!text) throw new ApiError(400, 'empty body');
        if (text.length > config.maxSnapshotBytes) {
            throw new ApiError(413, `snapshot exceeds ${config.maxSnapshotBytes} bytes`);
        }
        let data;
        try {
            data = JSON.parse(text);
        } catch {
            throw new ApiError(400, 'snapshot must be JSON');
        }
        await db.insert(snapshots).values({
            storeId: id,
            deviceId: request.headers.get('x-device-id'),
            data,
        });
        return json({ status: 'stored' }, 201);
    }));
}

export async function GET(request, { params }) {
    return withCors(await handleErrors(async () => {
        const { id } = await params;
        const db = await getDb();
        await authStore(db, request, id, 'read');
        const url = new URL(request.url);
        const limit = Math.min(Number.parseInt(url.searchParams.get('limit') ?? '90', 10) || 90, 1000);
        const rows = await db.select().from(snapshots)
            .where(eq(snapshots.storeId, id))
            .orderBy(desc(snapshots.receivedAt), desc(snapshots.id))
            .limit(limit);
        return json({
            snapshots: rows.map((r) => ({
                device_id: r.deviceId,
                received_at: r.receivedAt,
                data: r.data,
            })),
        });
    }));
}
