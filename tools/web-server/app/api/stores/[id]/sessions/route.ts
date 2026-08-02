import { asc, eq } from 'drizzle-orm';
import { authStore } from '@/lib/auth';
import { withCors } from '@/lib/cors';
import { getDb } from '@/lib/db';
import { ApiError, handleErrors, json } from '@/lib/http';
import { ingestSession } from '@/lib/ingest';
import { sessions } from '@/lib/schema';

export { OPTIONS } from '@/lib/cors';

type Context = { params: Promise<{ id: string }> };

// Ingest one raw session file (application/octet-stream, the exact bytes the
// device holds on flash). Idempotent: duplicates are dropped by content hash.
export async function POST(request: Request, { params }: Context): Promise<Response> {
    return withCors(
        await handleErrors(async () => {
            const { id } = await params;
            const db = await getDb();
            const { store } = await authStore(db, request, id, 'write');

            const buffer = await request.arrayBuffer();
            if (!buffer.byteLength) throw new ApiError(400, 'empty body');
            const result = await ingestSession(db, store, buffer, {
                deviceId: request.headers.get('x-device-id'),
                source: request.headers.get('x-source') === 'browser' ? 'browser' : 'device',
            });
            return json(result, result.status === 'stored' ? 201 : 200);
        }),
    );
}

// Summary listing for the dashboard: every scalar the session browser, trends
// and multi-session views need, without the blobs. Wire format is snake_case
// to match the parsed-session shape the analytics views already consume.
export async function GET(request: Request, { params }: Context): Promise<Response> {
    return withCors(
        await handleErrors(async () => {
            const { id } = await params;
            const db = await getDb();
            await authStore(db, request, id, 'read');
            const rows = await db
                .select()
                .from(sessions)
                .where(eq(sessions.storeId, id))
                .orderBy(asc(sessions.receivedAt), asc(sessions.id));
            return json({
                sessions: rows.map((row) => ({
                    sha256: row.sha256,
                    device_id: row.deviceId,
                    source: row.source,
                    received_at: row.receivedAt,
                    session_id: row.sessionId,
                    session_timestamp: row.sessionTimestamp,
                    session_size: row.sessionSize,
                    schema_version: row.schemaVersion,
                    event_count: row.eventCount,
                    measurement_count: row.measurementCount,
                    grind_mode: row.grindMode,
                    profile_id: row.profileId,
                    target_weight: row.targetWeight,
                    final_weight: row.finalWeight,
                    error_grams: row.errorGrams,
                    target_time_ms: row.targetTimeMs,
                    total_time_ms: row.totalTimeMs,
                    total_motor_on_time_ms: row.totalMotorOnTimeMs,
                    time_error_ms: row.timeErrorMs,
                    pulse_count: row.pulseCount,
                    termination_reason: row.terminationReason,
                    result_status: row.resultStatus,
                })),
            });
        }),
    );
}
