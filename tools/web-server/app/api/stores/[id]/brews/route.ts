// Brew-record ingest. The grinder queues one record per logged shot — grams out
// and, when the user answered the time step, the seconds it took — keyed by
// (session_id, session_timestamp), the same identity pair the manifest uses,
// because the device never knows a session's content hash. The server resolves
// the pair to the session's sha256 and lands the record on its annotation row.
// brew_time_s of 0 or absent means unmeasured and stores null.
//
// Responds with per-record status plus the current device config, so the
// grinder gets fresh advice in the same round trip. 'unknown' means the
// session hasn't uploaded yet (or ids reborn after a factory reset) — the
// device keeps the record queued and retries next window; 'deleted' and
// 'stored' both mean the record can be dropped.
import { and, desc, eq, sql } from 'drizzle-orm';
import { deviceConfig } from '@/lib/advice';
import { authStore } from '@/lib/auth';
import { parseMeasuredBrewTime } from '@/lib/beans';
import { withCors } from '@/lib/cors';
import { getDb } from '@/lib/db';
import { ApiError, handleErrors, json } from '@/lib/http';
import { annotations, deletedSessions, sessions } from '@/lib/schema';

export { OPTIONS } from '@/lib/cors';

type Context = { params: Promise<{ id: string }> };

const MAX_BATCH = 100;

interface BrewEntry {
    sessionId: number;
    sessionTimestamp: number;
    brewOutputG: number;
    brewTimeS: number | null;
}

function parseBrew(value: unknown): BrewEntry {
    if (typeof value !== 'object' || value === null) {
        throw new ApiError(400, 'each brew must be an object');
    }
    const entry = value as Record<string, unknown>;
    const sessionId = entry.session_id;
    const sessionTimestamp = entry.session_timestamp;
    if (
        !Number.isInteger(sessionId) ||
        !Number.isInteger(sessionTimestamp) ||
        (sessionId as number) < 0 ||
        (sessionTimestamp as number) < 0
    ) {
        throw new ApiError(400, 'each brew needs session_id and session_timestamp');
    }
    const output = entry.brew_output_g;
    if (typeof output !== 'number' || !Number.isFinite(output) || output <= 0 || output > 500) {
        throw new ApiError(400, 'brew_output_g must be a number between 0 and 500');
    }
    return {
        sessionId: sessionId as number,
        sessionTimestamp: sessionTimestamp as number,
        brewOutputG: Math.round(output * 10) / 10,
        brewTimeS: parseMeasuredBrewTime(entry.brew_time_s),
    };
}

export async function POST(request: Request, { params }: Context): Promise<Response> {
    return withCors(
        await handleErrors(async () => {
            const { id } = await params;
            const db = await getDb();
            const { store } = await authStore(db, request, id, 'write');

            let body: unknown;
            try {
                body = await request.json();
            } catch {
                throw new ApiError(400, 'body must be JSON');
            }
            const list =
                typeof body === 'object' && body !== null && 'brews' in body
                    ? (body as { brews: unknown }).brews
                    : undefined;
            if (!Array.isArray(list)) throw new ApiError(400, 'needs a brews array');
            if (list.length > MAX_BATCH) {
                throw new ApiError(413, `at most ${MAX_BATCH} brews per request`);
            }

            const results: {
                session_id: number;
                session_timestamp: number;
                status: 'stored' | 'deleted' | 'unknown';
            }[] = [];
            for (const raw of list) {
                const brew = parseBrew(raw);
                const found = await db
                    .select({ sha256: sessions.sha256 })
                    .from(sessions)
                    .where(
                        and(
                            eq(sessions.storeId, id),
                            eq(sessions.sessionId, brew.sessionId),
                            eq(sessions.sessionTimestamp, brew.sessionTimestamp),
                        ),
                    )
                    .orderBy(desc(sessions.receivedAt), desc(sessions.id))
                    .limit(1);
                const sha256 = found[0]?.sha256;
                if (!sha256) {
                    const tombstoned = await db
                        .select({ id: deletedSessions.id })
                        .from(deletedSessions)
                        .where(
                            and(
                                eq(deletedSessions.storeId, id),
                                eq(deletedSessions.sessionId, brew.sessionId),
                                eq(deletedSessions.sessionTimestamp, brew.sessionTimestamp),
                            ),
                        );
                    results.push({
                        session_id: brew.sessionId,
                        session_timestamp: brew.sessionTimestamp,
                        status: tombstoned.length ? 'deleted' : 'unknown',
                    });
                    continue;
                }

                // The brew is fresh data, so updated_at moves and the record
                // wins the next reconcile. The bean stamp only fills a blank —
                // a hand-picked bean on the row is never overwritten.
                await db
                    .insert(annotations)
                    .values({
                        storeId: id,
                        sha256,
                        beanId: store.activeBeanId,
                        brewOutputG: brew.brewOutputG,
                        brewTimeS: brew.brewTimeS,
                        updatedAt: new Date(),
                    })
                    .onConflictDoUpdate({
                        target: [annotations.storeId, annotations.sha256],
                        set: {
                            brewOutputG: brew.brewOutputG,
                            brewTimeS: brew.brewTimeS,
                            beanId: sql`coalesce(${annotations.beanId}, excluded.bean_id)`,
                            updatedAt: new Date(),
                        },
                    });
                results.push({
                    session_id: brew.sessionId,
                    session_timestamp: brew.sessionTimestamp,
                    status: 'stored',
                });
            }

            const config = await deviceConfig(db, store);
            return json({ results, ...config });
        }),
    );
}
