import { asc, eq } from 'drizzle-orm';
import { getDb } from '../../../../../lib/db.js';
import { json, handleErrors, ApiError } from '../../../../../lib/http.js';
import { withCors } from '../../../../../lib/cors.js';
import { authStore } from '../../../../../lib/auth.js';
import { ingestSession } from '../../../../../lib/ingest.js';
import { sessions } from '../../../../../lib/schema.js';

export { OPTIONS } from '../../../../../lib/cors.js';

// Ingest one raw session file (application/octet-stream, the exact bytes the
// device holds on flash). Idempotent: duplicates are dropped by content hash.
export async function POST(request, { params }) {
    return withCors(await handleErrors(async () => {
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
    }));
}

// Summary listing for the dashboard: every scalar the session browser, trends
// and multi-session views need, without the blobs. Wire format is snake_case
// to match the parsed-session shape the analytics views already consume.
export async function GET(request, { params }) {
    return withCors(await handleErrors(async () => {
        const { id } = await params;
        const db = await getDb();
        await authStore(db, request, id, 'read');
        const rows = await db.select().from(sessions)
            .where(eq(sessions.storeId, id))
            .orderBy(asc(sessions.receivedAt), asc(sessions.id));
        return json({
            sessions: rows.map((r) => ({
                sha256: r.sha256,
                device_id: r.deviceId,
                source: r.source,
                received_at: r.receivedAt,
                session_id: r.sessionId,
                session_timestamp: r.sessionTimestamp,
                session_size: r.sessionSize,
                schema_version: r.schemaVersion,
                event_count: r.eventCount,
                measurement_count: r.measurementCount,
                grind_mode: r.grindMode,
                profile_id: r.profileId,
                target_weight: r.targetWeight,
                final_weight: r.finalWeight,
                error_grams: r.errorGrams,
                target_time_ms: r.targetTimeMs,
                total_time_ms: r.totalTimeMs,
                total_motor_on_time_ms: r.totalMotorOnTimeMs,
                time_error_ms: r.timeErrorMs,
                pulse_count: r.pulseCount,
                termination_reason: r.terminationReason,
                result_status: r.resultStatus,
            })),
        });
    }));
}
