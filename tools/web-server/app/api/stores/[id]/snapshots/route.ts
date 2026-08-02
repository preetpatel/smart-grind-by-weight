import { desc, eq } from 'drizzle-orm';
import { authStore } from '@/lib/auth';
import { config } from '@/lib/config';
import { withCors } from '@/lib/cors';
import { getDb } from '@/lib/db';
import { ApiError, handleErrors, json } from '@/lib/http';
import { snapshots } from '@/lib/schema';

export { OPTIONS } from '@/lib/cors';

type Context = { params: Promise<{ id: string }> };

// Device health / lifetime-stats snapshots (docs/CLOUD_SYNC.md): timestamped
// observations POSTed after each successful sync. Kept as-is — the history is
// the value (noise creep, calibration drift, error rate vs firmware version).
export async function POST(request: Request, { params }: Context): Promise<Response> {
    return withCors(
        await handleErrors(async () => {
            const { id } = await params;
            const db = await getDb();
            await authStore(db, request, id, 'write');

            const text = await request.text();
            if (!text) throw new ApiError(400, 'empty body');
            if (text.length > config.maxSnapshotBytes) {
                throw new ApiError(413, `snapshot exceeds ${config.maxSnapshotBytes} bytes`);
            }
            let data: unknown;
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
        }),
    );
}

export async function GET(request: Request, { params }: Context): Promise<Response> {
    return withCors(
        await handleErrors(async () => {
            const { id } = await params;
            const db = await getDb();
            await authStore(db, request, id, 'read');
            const url = new URL(request.url);
            const limit = Math.min(
                Number.parseInt(url.searchParams.get('limit') ?? '90', 10) || 90,
                1000,
            );
            const rows = await db
                .select()
                .from(snapshots)
                .where(eq(snapshots.storeId, id))
                .orderBy(desc(snapshots.receivedAt), desc(snapshots.id))
                .limit(limit);
            return json({
                snapshots: rows.map((row) => ({
                    device_id: row.deviceId,
                    received_at: row.receivedAt,
                    data: row.data,
                })),
            });
        }),
    );
}
