// Edit, archive and delete one bean. Owner-session-only; no CORS by design.
import { and, eq } from 'drizzle-orm';
import { assertSameOrigin, authOwner } from '@/lib/auth';
import { BEAN_LIMITS, parseBrewTime, parseRatio, toBeanPayload, trimmedField } from '@/lib/beans';
import type { Db } from '@/lib/db';
import { getDb } from '@/lib/db';
import { ApiError, handleErrors, json } from '@/lib/http';
import { annotations, type BeanRow, beans, stores } from '@/lib/schema';

type Context = { params: Promise<{ id: string; beanId: string }> };

async function requireBean(db: Db, storeId: string, beanId: string): Promise<BeanRow> {
    const rows = await db
        .select()
        .from(beans)
        .where(and(eq(beans.storeId, storeId), eq(beans.id, beanId)));
    const bean = rows[0];
    if (!bean) throw new ApiError(404, 'bean not found');
    return bean;
}

export async function PATCH(request: Request, { params }: Context): Promise<Response> {
    return handleErrors(async () => {
        assertSameOrigin(request);
        const { id, beanId } = await params;
        const db = await getDb();
        const { store } = await authOwner(db, request, id);
        const bean = await requireBean(db, id, beanId);

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

        // Only fields present in the payload change; absent means keep.
        const set: Partial<typeof beans.$inferInsert> = { updatedAt: new Date() };
        if ('name' in entry) {
            const name = trimmedField(entry.name, BEAN_LIMITS.name);
            if (!name) throw new ApiError(400, 'a bean needs a name');
            set.name = name;
        }
        if ('ratio' in entry) set.ratio = parseRatio(entry.ratio);
        if ('brew_time_s' in entry) set.brewTimeS = parseBrewTime(entry.brew_time_s);
        if ('roast_date' in entry)
            set.roastDate = trimmedField(entry.roast_date, BEAN_LIMITS.roastDate);
        if ('notes' in entry) set.notes = trimmedField(entry.notes, BEAN_LIMITS.notes);
        if ('archived' in entry) {
            const archived = entry.archived === true;
            set.archivedAt = archived ? (bean.archivedAt ?? new Date()) : null;
            // Archiving the bag in the hopper means it's finished — nothing
            // is active until the owner picks the next one.
            if (archived && store.activeBeanId === beanId) {
                await db.update(stores).set({ activeBeanId: null }).where(eq(stores.id, id));
            }
        }

        const updated = await db
            .update(beans)
            .set(set)
            .where(and(eq(beans.storeId, id), eq(beans.id, beanId)))
            .returning();
        const row = updated[0];
        if (!row) throw new ApiError(404, 'bean not found');
        return json({ bean: toBeanPayload(row) });
    });
}

export async function DELETE(request: Request, { params }: Context): Promise<Response> {
    return handleErrors(async () => {
        assertSameOrigin(request);
        const { id, beanId } = await params;
        const db = await getDb();
        const { store } = await authOwner(db, request, id);
        await requireBean(db, id, beanId);

        // Sessions attributed to this bean keep their annotation rows; only
        // the attribution is cleared. updated_at is left alone — this is a
        // cascade cleanup, not an edit that should win an LWW race.
        await db
            .update(annotations)
            .set({ beanId: null })
            .where(and(eq(annotations.storeId, id), eq(annotations.beanId, beanId)));
        if (store.activeBeanId === beanId) {
            await db.update(stores).set({ activeBeanId: null }).where(eq(stores.id, id));
        }
        await db.delete(beans).where(and(eq(beans.storeId, id), eq(beans.id, beanId)));
        return json({ deleted: true });
    });
}
