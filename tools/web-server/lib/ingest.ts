// Session ingest: validate → dedup → store blob + summary row → quota.
//
// The structural validator is the same TypeScript parser the browser
// dashboard uses (one JS/TS parser for the grind_logging.h structs — see
// tools/ble/CLAUDE.md). A session that fails any structural check is
// rejected whole; corrupt data never reaches storage.
import { crc32 } from 'node:zlib';
import { and, count, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import {
    EVENT_STRUCT_SIZE,
    HEADER_SIZE,
    MEASUREMENT_STRUCT_SIZE,
    parseSessionFile,
    SESSION_STRUCT_SIZE,
} from '@/lib/parser';
import { config } from './config';
import type { Db } from './db';
import { ApiError } from './http';
import { sha256Hex } from './keys';
import { deletedSessions, type Store, sessions } from './schema';

type SessionInsert = typeof sessions.$inferInsert;
export type SessionSummary = Omit<
    SessionInsert,
    'id' | 'storeId' | 'deviceId' | 'sha256' | 'source' | 'receivedAt' | 'blob'
>;

export interface IngestOptions {
    deviceId?: string | null;
    source?: 'device' | 'browser';
}

export interface IngestResult {
    status: 'stored' | 'duplicate' | 'deleted';
    sha256: string;
    rotated: number;
}

// Validates one raw session file and returns its summary and content hash.
export function validateSessionBlob(buffer: ArrayBuffer): {
    sha256: string;
    summary: SessionSummary;
} {
    if (buffer.byteLength < HEADER_SIZE + SESSION_STRUCT_SIZE) {
        throw new ApiError(422, `session file too small (${buffer.byteLength} bytes)`);
    }
    const view = new DataView(buffer);
    const headerSessionId = view.getUint32(0, true);
    const headerTimestamp = view.getUint32(4, true);
    const sessionSize = view.getUint32(8, true);
    const headerChecksum = view.getUint32(12, true);
    const eventCount = view.getUint16(16, true);
    const measurementCount = view.getUint16(18, true);

    if (buffer.byteLength !== HEADER_SIZE + sessionSize) {
        throw new ApiError(
            422,
            `size mismatch: header says ${HEADER_SIZE + sessionSize} bytes, got ${buffer.byteLength}`,
        );
    }
    const expectedSize =
        SESSION_STRUCT_SIZE +
        eventCount * EVENT_STRUCT_SIZE +
        measurementCount * MEASUREMENT_STRUCT_SIZE;
    if (sessionSize !== expectedSize) {
        throw new ApiError(
            422,
            `size mismatch: ${eventCount} events + ${measurementCount} measurements imply ${expectedSize} bytes, header says ${sessionSize}`,
        );
    }
    // Legacy firmware writes checksum=0 (unimplemented); newer firmware fills
    // in a zlib CRC-32 of the payload after the header. Verify when present.
    if (headerChecksum !== 0) {
        const payload = new Uint8Array(buffer, HEADER_SIZE);
        const actual = crc32(payload) >>> 0;
        if (actual !== headerChecksum) {
            throw new ApiError(
                422,
                `checksum mismatch: header ${headerChecksum}, computed ${actual}`,
            );
        }
    }

    let parsed: ReturnType<typeof parseSessionFile>;
    try {
        parsed = parseSessionFile(buffer, headerSessionId);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new ApiError(422, `corrupt session file: ${message}`);
    }

    const s = parsed.session;
    return {
        sha256: sha256Hex(Buffer.from(buffer)),
        summary: {
            sessionId: s.session_id,
            sessionTimestamp: headerTimestamp,
            sessionSize,
            headerChecksum,
            schemaVersion: s.schema_version,
            eventCount,
            measurementCount,
            grindMode: s.grind_mode,
            profileId: s.profile_id,
            targetWeight: s.target_weight,
            finalWeight: s.final_weight,
            errorGrams: s.error_grams,
            targetTimeMs: s.target_time_ms,
            totalTimeMs: s.total_time_ms,
            totalMotorOnTimeMs: s.total_motor_on_time_ms,
            timeErrorMs: s.time_error_ms,
            pulseCount: s.pulse_count,
            terminationReason: s.termination_reason,
            resultStatus: s.result_status,
        },
    };
}

async function enforceUploadRate(db: Db, storeId: string): Promise<void> {
    const rows = await db
        .select({ n: count() })
        .from(sessions)
        .where(
            and(
                eq(sessions.storeId, storeId),
                gt(sessions.receivedAt, sql`now() - interval '1 hour'`),
            ),
        );
    if ((rows[0]?.n ?? 0) >= config.uploadsPerHour) {
        throw new ApiError(429, 'upload rate limit reached; try again later');
    }
}

// Keeps the newest `quota` sessions (arrival order — mirrors the device's own
// oldest-first purge). Returns how many were rotated out.
async function enforceQuota(db: Db, storeId: string): Promise<number> {
    const quota = config.sessionQuota;
    if (quota <= 0) return 0;
    const beyondQuota = db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.storeId, storeId))
        .orderBy(desc(sessions.receivedAt), desc(sessions.id))
        .offset(quota);
    const rotated = await db
        .delete(sessions)
        .where(and(eq(sessions.storeId, storeId), inArray(sessions.id, beyondQuota)))
        .returning({ id: sessions.id });
    return rotated.length;
}

// Idempotent ingest of one raw session blob.
export async function ingestSession(
    db: Db,
    store: Store,
    buffer: ArrayBuffer,
    { deviceId = null, source = 'device' }: IngestOptions = {},
): Promise<IngestResult> {
    if (buffer.byteLength > config.maxSessionBytes) {
        throw new ApiError(413, `session file exceeds ${config.maxSessionBytes} bytes`);
    }
    await enforceUploadRate(db, store.id);

    const { sha256, summary } = validateSessionBlob(buffer);

    // A grind the owner deleted stays deleted. The manifest already tells a
    // well-behaved device not to send it, but ingest is reachable directly, so
    // the tombstone is enforced here too rather than trusted upstream.
    const tombstoned = await db
        .select({ sha256: deletedSessions.sha256 })
        .from(deletedSessions)
        .where(and(eq(deletedSessions.storeId, store.id), eq(deletedSessions.sha256, sha256)));
    if (tombstoned.length) return { status: 'deleted', sha256, rotated: 0 };

    const inserted = await db
        .insert(sessions)
        .values({
            storeId: store.id,
            deviceId,
            sha256,
            source,
            blob: Buffer.from(buffer),
            ...summary,
        })
        .onConflictDoNothing({ target: [sessions.storeId, sessions.sha256] })
        .returning({ id: sessions.id });

    if (!inserted.length) return { status: 'duplicate', sha256, rotated: 0 };

    const rotated = await enforceQuota(db, store.id);
    return { status: 'stored', sha256, rotated };
}
