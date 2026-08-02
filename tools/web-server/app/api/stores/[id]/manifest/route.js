import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../../../../lib/db.js';
import { json, handleErrors, ApiError } from '../../../../../lib/http.js';
import { withCors } from '../../../../../lib/cors.js';
import { authStore } from '../../../../../lib/auth.js';
import { config } from '../../../../../lib/config.js';
import { sessions } from '../../../../../lib/schema.js';

export { OPTIONS } from '../../../../../lib/cors.js';

// Manifest handshake (docs/CLOUD_SYNC.md "Sync protocol"): the device sends
// one (session_id, session_timestamp, session_size, checksum) tuple per file
// on its flash; we reply with the session_ids we don't hold. Matching on the
// whole tuple (not just the id) makes a factory-reset device's reborn ids
// look new, and makes a wiped server re-request everything — the server is
// the only sync state in the system.
export async function POST(request, { params }) {
    return withCors(await handleErrors(async () => {
        const { id } = await params;
        const db = await getDb();
        await authStore(db, request, id, 'write');

        let body;
        try {
            body = await request.json();
        } catch {
            throw new ApiError(400, 'manifest must be JSON');
        }
        const entries = body?.sessions;
        if (!Array.isArray(entries)) throw new ApiError(400, 'manifest needs a sessions array');
        if (entries.length > config.manifestMaxEntries) {
            throw new ApiError(413, `manifest exceeds ${config.manifestMaxEntries} entries`);
        }
        for (const e of entries) {
            if (!Number.isInteger(e?.session_id) || !Number.isInteger(e?.session_timestamp)
                || !Number.isInteger(e?.session_size) || !Number.isInteger(e?.checksum)) {
                throw new ApiError(400, 'each manifest entry needs integer session_id, session_timestamp, session_size, checksum');
            }
        }
        if (!entries.length) return json({ want: [] });

        const ids = [...new Set(entries.map((e) => e.session_id))];
        const rows = await db.select({
            sessionId: sessions.sessionId,
            sessionTimestamp: sessions.sessionTimestamp,
            sessionSize: sessions.sessionSize,
            headerChecksum: sessions.headerChecksum,
        }).from(sessions).where(and(
            eq(sessions.storeId, id),
            inArray(sessions.sessionId, ids),
        ));
        const known = new Set(rows.map((r) =>
            `${r.sessionId}:${r.sessionTimestamp}:${r.sessionSize}:${r.headerChecksum}`));
        const want = entries
            .filter((e) => !known.has(`${e.session_id}:${e.session_timestamp}:${e.session_size}:${e.checksum}`))
            .map((e) => e.session_id);
        return json({ want });
    }));
}
