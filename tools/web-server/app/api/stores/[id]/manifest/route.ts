import { and, eq, inArray } from 'drizzle-orm';
import { authStore } from '@/lib/auth';
import { config } from '@/lib/config';
import { withCors } from '@/lib/cors';
import { getDb } from '@/lib/db';
import { ApiError, handleErrors, json } from '@/lib/http';
import { deletedSessions, sessions } from '@/lib/schema';

export { OPTIONS } from '@/lib/cors';

type Context = { params: Promise<{ id: string }> };

interface ManifestEntry {
    session_id: number;
    session_timestamp: number;
    session_size: number;
    checksum: number;
}

function isManifestEntry(value: unknown): value is ManifestEntry {
    if (typeof value !== 'object' || value === null) return false;
    const entry = value as Record<string, unknown>;
    return (
        Number.isInteger(entry.session_id) &&
        Number.isInteger(entry.session_timestamp) &&
        Number.isInteger(entry.session_size) &&
        Number.isInteger(entry.checksum)
    );
}

// Manifest handshake (docs/CLOUD_SYNC.md "Sync protocol"): the device sends
// one (session_id, session_timestamp, session_size, checksum) tuple per file
// on its flash; we reply with the session_ids we don't hold. Matching on the
// whole tuple (not just the id) makes a factory-reset device's reborn ids
// look new, and makes a wiped server re-request everything — the server is
// the only sync state in the system.
export async function POST(request: Request, { params }: Context): Promise<Response> {
    return withCors(
        await handleErrors(async () => {
            const { id } = await params;
            const db = await getDb();
            await authStore(db, request, id, 'write');

            let body: unknown;
            try {
                body = await request.json();
            } catch {
                throw new ApiError(400, 'manifest must be JSON');
            }
            const entries =
                typeof body === 'object' && body !== null && 'sessions' in body
                    ? (body as { sessions: unknown }).sessions
                    : undefined;
            if (!Array.isArray(entries)) throw new ApiError(400, 'manifest needs a sessions array');
            if (entries.length > config.manifestMaxEntries) {
                throw new ApiError(413, `manifest exceeds ${config.manifestMaxEntries} entries`);
            }
            if (!entries.every(isManifestEntry)) {
                throw new ApiError(
                    400,
                    'each manifest entry needs integer session_id, session_timestamp, session_size, checksum',
                );
            }
            if (!entries.length) return json({ want: [] });

            const ids = [...new Set(entries.map((entry) => entry.session_id))];
            const rows = await db
                .select({
                    sessionId: sessions.sessionId,
                    sessionTimestamp: sessions.sessionTimestamp,
                    sessionSize: sessions.sessionSize,
                    headerChecksum: sessions.headerChecksum,
                })
                .from(sessions)
                .where(and(eq(sessions.storeId, id), inArray(sessions.sessionId, ids)));
            const known = new Set(
                rows.map(
                    (row) =>
                        `${row.sessionId}:${row.sessionTimestamp}:${row.sessionSize}:${row.headerChecksum}`,
                ),
            );
            // Sessions the owner deleted must not come back on the next
            // sync, so tombstones count as "already have it" here. Matched on
            // (session_id, timestamp) because the device has not uploaded the
            // bytes and so cannot know the content hash.
            const tombstones = await db
                .select({
                    sessionId: deletedSessions.sessionId,
                    sessionTimestamp: deletedSessions.sessionTimestamp,
                })
                .from(deletedSessions)
                .where(
                    and(eq(deletedSessions.storeId, id), inArray(deletedSessions.sessionId, ids)),
                );
            const deleted = new Set(
                tombstones.map((row) => `${row.sessionId}:${row.sessionTimestamp}`),
            );

            const want = entries
                .filter(
                    (entry) =>
                        !known.has(
                            `${entry.session_id}:${entry.session_timestamp}:${entry.session_size}:${entry.checksum}`,
                        ) && !deleted.has(`${entry.session_id}:${entry.session_timestamp}`),
                )
                .map((entry) => entry.session_id);
            return json({ want });
        }),
    );
}
