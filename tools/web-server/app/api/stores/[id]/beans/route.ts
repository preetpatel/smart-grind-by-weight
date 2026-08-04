// Bean list and creation. Reads are key-authable (viewers group charts by
// bean); creation is owner-session-only like all store management.
import { desc, eq } from 'drizzle-orm';
import { assertSameOrigin, authOwner, authStore } from '@/lib/auth';
import {
    assertRecipeConsistent,
    BEAN_LIMITS,
    MAX_BEANS_PER_STORE,
    parseBagSize,
    parseBrewTime,
    parseDose,
    parseRatio,
    parseTimeEdge,
    parseYieldEdge,
    toBeanPayload,
    trimmedField,
} from '@/lib/beans';
import { withCors } from '@/lib/cors';
import { getDb } from '@/lib/db';
import { ApiError, handleErrors, json } from '@/lib/http';
import { newBeanId } from '@/lib/keys';
import { beans, stores } from '@/lib/schema';

export { OPTIONS } from '@/lib/cors';

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context): Promise<Response> {
    return withCors(
        await handleErrors(async () => {
            const { id } = await params;
            const db = await getDb();
            const { store } = await authStore(db, request, id, 'read');
            const rows = await db
                .select()
                .from(beans)
                .where(eq(beans.storeId, id))
                .orderBy(desc(beans.createdAt), desc(beans.id));
            return json({
                beans: rows.map(toBeanPayload),
                active_bean_id: store.activeBeanId,
            });
        }),
    );
}

export async function POST(request: Request, { params }: Context): Promise<Response> {
    return handleErrors(async () => {
        assertSameOrigin(request);
        const { id } = await params;
        const db = await getDb();
        const { store } = await authOwner(db, request, id);

        let body: unknown;
        try {
            body = await request.json();
        } catch {
            throw new ApiError(400, 'body must be JSON');
        }
        const entry = (typeof body === 'object' && body !== null ? body : {}) as Record<
            string,
            unknown
        >;
        const name = trimmedField(entry.name, BEAN_LIMITS.name);
        if (!name) throw new ApiError(400, 'a bean needs a name');
        const ratio = parseRatio(entry.ratio);
        const brewTimeS = entry.brew_time_s === undefined ? 30 : parseBrewTime(entry.brew_time_s);
        const bagSizeG = entry.bag_size_g === undefined ? null : parseBagSize(entry.bag_size_g);
        const recipe = {
            doseG: entry.dose_g === undefined ? null : parseDose(entry.dose_g),
            yieldMinG:
                entry.yield_min_g === undefined
                    ? null
                    : parseYieldEdge(entry.yield_min_g, 'yield_min_g'),
            yieldMaxG:
                entry.yield_max_g === undefined
                    ? null
                    : parseYieldEdge(entry.yield_max_g, 'yield_max_g'),
            timeMinS:
                entry.time_min_s === undefined
                    ? null
                    : parseTimeEdge(entry.time_min_s, 'time_min_s'),
            timeMaxS:
                entry.time_max_s === undefined
                    ? null
                    : parseTimeEdge(entry.time_max_s, 'time_max_s'),
        };
        assertRecipeConsistent(recipe);

        const existing = await db.select({ id: beans.id }).from(beans).where(eq(beans.storeId, id));
        if (existing.length >= MAX_BEANS_PER_STORE) {
            throw new ApiError(429, `at most ${MAX_BEANS_PER_STORE} beans per store`);
        }

        const inserted = await db
            .insert(beans)
            .values({
                id: newBeanId(),
                storeId: id,
                name,
                ratio,
                brewTimeS,
                bagSizeG,
                ...recipe,
                roastDate: trimmedField(entry.roast_date, BEAN_LIMITS.roastDate),
                notes: trimmedField(entry.notes, BEAN_LIMITS.notes),
            })
            .returning();
        const bean = inserted[0];
        if (!bean) throw new ApiError(500, 'bean insert returned nothing');

        // A store's first bean is what's in the hopper; activating it here
        // saves the obvious second click. Later bags stay explicit.
        let activeBeanId = store.activeBeanId;
        if (!activeBeanId) {
            activeBeanId = bean.id;
            await db.update(stores).set({ activeBeanId }).where(eq(stores.id, id));
        }
        return json({ bean: toBeanPayload(bean), active_bean_id: activeBeanId }, 201);
    });
}
