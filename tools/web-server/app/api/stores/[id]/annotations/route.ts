import { and, eq, inArray, sql } from 'drizzle-orm';
import { authStore } from '@/lib/auth';
import { isBeanId } from '@/lib/beans';
import { withCors } from '@/lib/cors';
import { getDb } from '@/lib/db';
import { ApiError, handleErrors, json } from '@/lib/http';
import { annotations } from '@/lib/schema';

export { OPTIONS } from '@/lib/cors';

type Context = { params: Promise<{ id: string }> };

const MAX_BATCH = 500;
const LIMITS = { bean: 120, roastDate: 32, grindSetting: 48, note: 2000, tag: 40 };
const MAX_TAGS = 12;

export interface AnnotationPayload {
    sha256: string;
    bean: string | null;
    roast_date: string | null;
    grind_setting: string | null;
    note: string | null;
    tags: string[];
    bean_id: string | null;
    brew_output_g: number | null;
    brew_time_s: number | null;
    updated_at: string;
}

// Empty strings are the same statement as "unset" here, and storing both
// makes every downstream comparison ambiguous.
function trimmed(value: unknown, max: number): string | null {
    if (typeof value !== 'string') return null;
    const text = value.trim().slice(0, max);
    return text.length ? text : null;
}

// Brew fields distinguish "absent" (a client that predates them, or one that
// simply didn't touch them — keep whatever is stored) from an explicit null
// (clear it). Without that, any LWW-newer row from an older browser would
// silently wipe the brew data the grinder collected.
function optionalNumber(
    entry: Record<string, unknown>,
    key: string,
    check: (value: number) => boolean,
): number | null | undefined {
    if (!(key in entry)) return undefined;
    const value = entry[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || !check(value)) return null;
    return value;
}

function parseEntry(value: unknown): {
    sha256: string;
    bean: string | null;
    roastDate: string | null;
    grindSetting: string | null;
    note: string | null;
    tags: string[];
    beanId: string | null | undefined;
    brewOutputG: number | null | undefined;
    brewTimeS: number | null | undefined;
    updatedAt: Date;
} {
    if (typeof value !== 'object' || value === null) {
        throw new ApiError(400, 'each annotation must be an object');
    }
    const entry = value as Record<string, unknown>;
    if (typeof entry.sha256 !== 'string' || !/^[0-9a-z]{16,80}$/i.test(entry.sha256)) {
        throw new ApiError(400, 'each annotation needs a sha256');
    }
    const rawTags = Array.isArray(entry.tags) ? entry.tags : [];
    const tags = [
        ...new Set(
            rawTags
                .map((tag) => trimmed(tag, LIMITS.tag))
                .filter((tag): tag is string => tag !== null),
        ),
    ].slice(0, MAX_TAGS);
    const updated = typeof entry.updated_at === 'string' ? new Date(entry.updated_at) : new Date();
    const brewOutput = optionalNumber(entry, 'brew_output_g', (v) => v > 0 && v <= 500);
    return {
        sha256: entry.sha256,
        bean: trimmed(entry.bean, LIMITS.bean),
        roastDate: trimmed(entry.roast_date, LIMITS.roastDate),
        grindSetting: trimmed(entry.grind_setting, LIMITS.grindSetting),
        note: trimmed(entry.note, LIMITS.note),
        tags,
        beanId: 'bean_id' in entry ? (isBeanId(entry.bean_id) ? entry.bean_id : null) : undefined,
        brewOutputG:
            brewOutput === undefined ? undefined : brewOutput && Math.round(brewOutput * 10) / 10,
        brewTimeS: optionalNumber(
            entry,
            'brew_time_s',
            (v) => Number.isInteger(v) && v >= 1 && v <= 3600,
        ),
        updatedAt: Number.isNaN(updated.getTime()) ? new Date() : updated,
    };
}

function toPayload(row: {
    sha256: string;
    bean: string | null;
    roastDate: string | null;
    grindSetting: string | null;
    note: string | null;
    tags: string[];
    beanId: string | null;
    brewOutputG: number | null;
    brewTimeS: number | null;
    updatedAt: Date;
}): AnnotationPayload {
    return {
        sha256: row.sha256,
        bean: row.bean,
        roast_date: row.roastDate,
        grind_setting: row.grindSetting,
        note: row.note,
        tags: row.tags ?? [],
        bean_id: row.beanId,
        brew_output_g: row.brewOutputG,
        brew_time_s: row.brewTimeS,
        updated_at: row.updatedAt.toISOString(),
    };
}

// Read every annotation in the store. Small enough to send whole — one row per
// annotated grind, a few hundred bytes each — so the client can reconcile
// offline edits in one pass rather than per session.
export async function GET(request: Request, { params }: Context): Promise<Response> {
    return withCors(
        await handleErrors(async () => {
            const { id } = await params;
            const db = await getDb();
            await authStore(db, request, id, 'read');
            const rows = await db.select().from(annotations).where(eq(annotations.storeId, id));
            return json({ annotations: rows.map(toPayload) });
        }),
    );
}

// Upsert a batch, last-write-wins on updated_at. The client sends whatever it
// has changed since its last sync; conflicts are resolved per row rather than
// per batch, so two browsers editing different grinds never clobber each other.
export async function PUT(request: Request, { params }: Context): Promise<Response> {
    return withCors(
        await handleErrors(async () => {
            const { id } = await params;
            const db = await getDb();
            await authStore(db, request, id, 'write');

            let body: unknown;
            try {
                body = await request.json();
            } catch {
                throw new ApiError(400, 'body must be JSON');
            }
            const list =
                typeof body === 'object' && body !== null && 'annotations' in body
                    ? (body as { annotations: unknown }).annotations
                    : undefined;
            if (!Array.isArray(list)) throw new ApiError(400, 'needs an annotations array');
            if (list.length > MAX_BATCH) {
                throw new ApiError(413, `at most ${MAX_BATCH} annotations per request`);
            }
            if (!list.length) return json({ stored: 0, annotations: [] });

            const parsed = list.map(parseEntry);
            const existing = await db
                .select({ sha256: annotations.sha256, updatedAt: annotations.updatedAt })
                .from(annotations)
                .where(
                    and(
                        eq(annotations.storeId, id),
                        inArray(
                            annotations.sha256,
                            parsed.map((entry) => entry.sha256),
                        ),
                    ),
                );
            const currentlyAt = new Map(existing.map((row) => [row.sha256, row.updatedAt]));

            let stored = 0;
            for (const entry of parsed) {
                const seen = currentlyAt.get(entry.sha256);
                // A stale edit (an older tab flushing after a newer one) is
                // dropped rather than applied.
                if (seen && seen.getTime() > entry.updatedAt.getTime()) continue;
                await db
                    .insert(annotations)
                    .values({
                        storeId: id,
                        ...entry,
                        beanId: entry.beanId ?? null,
                        brewOutputG: entry.brewOutputG ?? null,
                        brewTimeS: entry.brewTimeS ?? null,
                    })
                    .onConflictDoUpdate({
                        target: [annotations.storeId, annotations.sha256],
                        set: {
                            bean: entry.bean,
                            roastDate: entry.roastDate,
                            grindSetting: entry.grindSetting,
                            note: entry.note,
                            tags: entry.tags,
                            // undefined = the client never sent the field;
                            // the stored value stays put.
                            beanId:
                                entry.beanId === undefined
                                    ? sql`${annotations.beanId}`
                                    : entry.beanId,
                            brewOutputG:
                                entry.brewOutputG === undefined
                                    ? sql`${annotations.brewOutputG}`
                                    : entry.brewOutputG,
                            brewTimeS:
                                entry.brewTimeS === undefined
                                    ? sql`${annotations.brewTimeS}`
                                    : entry.brewTimeS,
                            updatedAt: entry.updatedAt,
                        },
                    });
                stored += 1;
            }

            const rows = await db.select().from(annotations).where(eq(annotations.storeId, id));
            return json({ stored, annotations: rows.map(toPayload) });
        }),
    );
}
