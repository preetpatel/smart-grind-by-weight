import { and, eq, inArray } from 'drizzle-orm';
import { authStore } from '@/lib/auth';
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
    updated_at: string;
}

// Empty strings are the same statement as "unset" here, and storing both
// makes every downstream comparison ambiguous.
function trimmed(value: unknown, max: number): string | null {
    if (typeof value !== 'string') return null;
    const text = value.trim().slice(0, max);
    return text.length ? text : null;
}

function parseEntry(value: unknown): {
    sha256: string;
    bean: string | null;
    roastDate: string | null;
    grindSetting: string | null;
    note: string | null;
    tags: string[];
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
    return {
        sha256: entry.sha256,
        bean: trimmed(entry.bean, LIMITS.bean),
        roastDate: trimmed(entry.roast_date, LIMITS.roastDate),
        grindSetting: trimmed(entry.grind_setting, LIMITS.grindSetting),
        note: trimmed(entry.note, LIMITS.note),
        tags,
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
    updatedAt: Date;
}): AnnotationPayload {
    return {
        sha256: row.sha256,
        bean: row.bean,
        roast_date: row.roastDate,
        grind_setting: row.grindSetting,
        note: row.note,
        tags: row.tags ?? [],
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
                    .values({ storeId: id, ...entry })
                    .onConflictDoUpdate({
                        target: [annotations.storeId, annotations.sha256],
                        set: {
                            bean: entry.bean,
                            roastDate: entry.roastDate,
                            grindSetting: entry.grindSetting,
                            note: entry.note,
                            tags: entry.tags,
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
