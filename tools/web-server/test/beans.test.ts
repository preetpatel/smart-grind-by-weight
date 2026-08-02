// Beans, brew records and the advice engine: the bag registry, ingest-time
// attribution, the device's brew upload, and the finer/coarser verdict.
import { beforeEach, describe, expect, it } from 'vitest';
import { api, freshDb, newDeviceId, newStore, signUp } from './helpers/api';
import { buildSessionBlob } from './helpers/blob';

beforeEach(async () => {
    await freshDb();
});

interface BeanBody {
    bean: { id: string; name: string; ratio: number; brew_time_s: number; archived: boolean };
    active_bean_id: string | null;
}

async function createBean(
    storeId: string,
    cookie: string,
    body: Record<string, unknown> = {},
): Promise<BeanBody> {
    const response = await api.createBean(storeId, {
        cookie,
        body: { name: 'Atomic Veloce', ratio: 1.5, ...body },
    });
    expect(response.status).toBe(201);
    return (await response.json()) as BeanBody;
}

async function ingestBlob(
    storeId: string,
    key: string,
    options: Parameters<typeof buildSessionBlob>[0] = {},
): Promise<string> {
    const response = await api.ingest(storeId, { key, body: buildSessionBlob(options) });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { sha256: string };
    return body.sha256;
}

describe('bean registry', () => {
    it('creates a bean and auto-activates the first one only', async () => {
        const store = await newStore();
        const first = await createBean(store.store_id, store.cookie);
        expect(first.active_bean_id).toBe(first.bean.id);
        expect(first.bean.brew_time_s).toBe(30);

        const second = await createBean(store.store_id, store.cookie, { name: 'Rocket Blend' });
        expect(second.active_bean_id).toBe(first.bean.id);
    });

    it('lets viewers read beans but never manage them', async () => {
        const store = await newStore();
        const { bean } = await createBean(store.store_id, store.cookie);

        const list = await api.listBeans(store.store_id, { key: store.view_key });
        expect(list.status).toBe(200);
        const body = (await list.json()) as { beans: unknown[]; active_bean_id: string };
        expect(body.beans).toHaveLength(1);
        expect(body.active_bean_id).toBe(bean.id);

        const denied = await api.createBean(store.store_id, {
            key: store.upload_key,
            body: { name: 'Sneaky', ratio: 2 },
        });
        expect(denied.status).toBe(401);
    });

    it('activate switches bags and un-archives the chosen one', async () => {
        const store = await newStore();
        const first = await createBean(store.store_id, store.cookie);
        const second = await createBean(store.store_id, store.cookie, { name: 'Monsoon' });

        const archived = await api.patchBean(store.store_id, second.bean.id, {
            cookie: store.cookie,
            body: { archived: true },
        });
        expect(archived.status).toBe(200);

        const activate = await api.activateBean(store.store_id, second.bean.id, {
            cookie: store.cookie,
        });
        expect(activate.status).toBe(200);
        const list = (await (
            await api.listBeans(store.store_id, { cookie: store.cookie })
        ).json()) as { beans: { id: string; archived: boolean }[]; active_bean_id: string };
        expect(list.active_bean_id).toBe(second.bean.id);
        expect(list.beans.find((entry) => entry.id === second.bean.id)?.archived).toBe(false);
        expect(first.active_bean_id).toBe(first.bean.id);
    });

    it('archiving the active bag leaves nothing active', async () => {
        const store = await newStore();
        const { bean } = await createBean(store.store_id, store.cookie);
        await api.patchBean(store.store_id, bean.id, {
            cookie: store.cookie,
            body: { archived: true },
        });
        const list = (await (
            await api.listBeans(store.store_id, { cookie: store.cookie })
        ).json()) as { active_bean_id: string | null };
        expect(list.active_bean_id).toBeNull();
    });

    it('rejects a foreign owner', async () => {
        const store = await newStore();
        const stranger = await signUp();
        const denied = await api.createBean(store.store_id, {
            cookie: stranger,
            body: { name: 'Not mine', ratio: 2 },
        });
        expect(denied.status).toBe(403);
    });
});

describe('bean attribution at ingest', () => {
    it('stamps the active bean on newly ingested sessions', async () => {
        const store = await newStore();
        const { bean } = await createBean(store.store_id, store.cookie);
        const sha = await ingestBlob(store.store_id, store.upload_key);

        const body = (await (
            await api.getAnnotations(store.store_id, { cookie: store.cookie })
        ).json()) as { annotations: { sha256: string; bean_id: string | null }[] };
        expect(body.annotations.find((row) => row.sha256 === sha)?.bean_id).toBe(bean.id);
    });

    it('never overwrites a bean the owner picked by hand', async () => {
        const store = await newStore();
        await createBean(store.store_id, store.cookie);
        const second = await createBean(store.store_id, store.cookie, { name: 'Monsoon' });

        // Annotation written before the session uploads — supported by design.
        const blob = buildSessionBlob({ sessionId: 7, timestamp: 1754000007 });
        const sha = (await import('node:crypto'))
            .createHash('sha256')
            .update(Buffer.from(blob))
            .digest('hex');
        await api.putAnnotations(store.store_id, {
            cookie: store.cookie,
            body: { annotations: [{ sha256: sha, bean_id: second.bean.id }] },
        });

        await ingestBlob(store.store_id, store.upload_key, {
            sessionId: 7,
            timestamp: 1754000007,
        });
        const body = (await (
            await api.getAnnotations(store.store_id, { cookie: store.cookie })
        ).json()) as { annotations: { sha256: string; bean_id: string | null }[] };
        expect(body.annotations.find((row) => row.sha256 === sha)?.bean_id).toBe(second.bean.id);
    });
});

describe('brew records', () => {
    it('lands a device brew on the session annotation and echoes fresh advice', async () => {
        const store = await newStore();
        const { bean } = await createBean(store.store_id, store.cookie);
        const sha = await ingestBlob(store.store_id, store.upload_key, {
            sessionId: 3,
            timestamp: 1754000003,
        });

        const response = await api.postBrews(store.store_id, {
            key: store.upload_key,
            body: {
                brews: [
                    {
                        session_id: 3,
                        session_timestamp: 1754000003,
                        brew_output_g: 30.1,
                        brew_time_s: 30,
                    },
                ],
            },
        });
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
            results: { status: string }[];
            bean: { id: string };
            advice: { verdict: string };
        };
        expect(body.results[0]?.status).toBe('stored');
        expect(body.bean.id).toBe(bean.id);
        expect(body.advice.verdict).toBe('none');

        const annotations = (await (
            await api.getAnnotations(store.store_id, { cookie: store.cookie })
        ).json()) as {
            annotations: {
                sha256: string;
                brew_output_g: number | null;
                brew_time_s: number | null;
            }[];
        };
        const row = annotations.annotations.find((entry) => entry.sha256 === sha);
        expect(row?.brew_output_g).toBeCloseTo(30.1, 5);
        expect(row?.brew_time_s).toBe(30);
    });

    it('reports unknown for sessions that have not uploaded yet', async () => {
        const store = await newStore();
        const response = await api.postBrews(store.store_id, {
            key: store.upload_key,
            body: { brews: [{ session_id: 99, session_timestamp: 1754000099, brew_output_g: 30 }] },
        });
        const body = (await response.json()) as { results: { status: string }[] };
        expect(body.results[0]?.status).toBe('unknown');
    });

    it('reports deleted for tombstoned sessions so the device drops the record', async () => {
        const store = await newStore();
        const sha = await ingestBlob(store.store_id, store.upload_key, {
            sessionId: 5,
            timestamp: 1754000005,
        });
        const deleted = await api.deleteSession(store.store_id, sha, { cookie: store.cookie });
        expect(deleted.status).toBe(200);

        const response = await api.postBrews(store.store_id, {
            key: store.upload_key,
            body: { brews: [{ session_id: 5, session_timestamp: 1754000005, brew_output_g: 30 }] },
        });
        const body = (await response.json()) as { results: { status: string }[] };
        expect(body.results[0]?.status).toBe('deleted');
    });

    it('refuses another grinder presenting the right key', async () => {
        const store = await newStore();
        const response = await api.postBrews(store.store_id, {
            key: store.upload_key,
            headers: { 'x-device-id': newDeviceId() },
            body: { brews: [] },
        });
        expect(response.status).toBe(403);
    });
});

describe('device config and advice', () => {
    async function shotWithBrew(
        store: { store_id: string; upload_key: string },
        sessionId: number,
        outputG: number,
    ): Promise<string> {
        const sha = await ingestBlob(store.store_id, store.upload_key, {
            sessionId,
            timestamp: 1754000000 + sessionId,
        });
        await api.postBrews(store.store_id, {
            key: store.upload_key,
            body: {
                brews: [
                    {
                        session_id: sessionId,
                        session_timestamp: 1754000000 + sessionId,
                        brew_output_g: outputG,
                        brew_time_s: 30,
                    },
                ],
            },
        });
        return sha;
    }

    it('serves the active bean over the view key with no advice until enough shots', async () => {
        const store = await newStore();
        const { bean } = await createBean(store.store_id, store.cookie);
        const response = await api.getConfig(store.store_id, { key: store.view_key });
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
            bean: { id: string; ratio: number } | null;
            advice: { verdict: string; shots_considered: number };
        };
        expect(body.bean?.id).toBe(bean.id);
        expect(body.bean?.ratio).toBeCloseTo(1.5, 5);
        expect(body.advice.verdict).toBe('none');
    });

    it('advises finer when shots keep running fast', async () => {
        const store = await newStore();
        await createBean(store.store_id, store.cookie);
        // Dose 18.02 g at 1:1.5 expects ~27 g; 30 g out is ~+11% — fast.
        await shotWithBrew(store, 1, 30);
        await shotWithBrew(store, 2, 30.4);
        await shotWithBrew(store, 3, 29.8);

        const body = (await (
            await api.getConfig(store.store_id, { key: store.upload_key })
        ).json()) as { advice: { verdict: string; shots_considered: number } };
        expect(body.advice.verdict).toBe('finer');
        expect(body.advice.shots_considered).toBe(3);
    });

    it('advises coarser when shots keep choking', async () => {
        const store = await newStore();
        await createBean(store.store_id, store.cookie);
        await shotWithBrew(store, 1, 23);
        await shotWithBrew(store, 2, 23.5);
        await shotWithBrew(store, 3, 22.8);

        const body = (await (
            await api.getConfig(store.store_id, { key: store.upload_key })
        ).json()) as { advice: { verdict: string } };
        expect(body.advice.verdict).toBe('coarser');
    });

    it('a grind-setting change resets the evidence', async () => {
        const store = await newStore();
        await createBean(store.store_id, store.cookie);
        const oldShots = [
            await shotWithBrew(store, 1, 30),
            await shotWithBrew(store, 2, 30.4),
            await shotWithBrew(store, 3, 29.8),
        ];
        await api.putAnnotations(store.store_id, {
            cookie: store.cookie,
            body: {
                annotations: oldShots.map((sha256) => ({ sha256, grind_setting: '6' })),
            },
        });

        // The user tightened the burrs; the next fast shot alone is not
        // enough evidence to nag again.
        const fresh = await shotWithBrew(store, 4, 30.2);
        await api.putAnnotations(store.store_id, {
            cookie: store.cookie,
            body: { annotations: [{ sha256: fresh, grind_setting: '5.5' }] },
        });

        const body = (await (
            await api.getConfig(store.store_id, { key: store.upload_key })
        ).json()) as { advice: { verdict: string; shots_considered: number } };
        expect(body.advice.verdict).toBe('none');
        expect(body.advice.shots_considered).toBe(1);
    });

    it('legacy annotation pushes never wipe brew data they do not know about', async () => {
        const store = await newStore();
        await createBean(store.store_id, store.cookie);
        const sha = await shotWithBrew(store, 8, 30);

        // An older client pushes a newer note without any brew fields.
        await api.putAnnotations(store.store_id, {
            cookie: store.cookie,
            body: {
                annotations: [
                    { sha256: sha, note: 'lovely crema', updated_at: new Date().toISOString() },
                ],
            },
        });
        const body = (await (
            await api.getAnnotations(store.store_id, { cookie: store.cookie })
        ).json()) as {
            annotations: { sha256: string; note: string | null; brew_output_g: number | null }[];
        };
        const row = body.annotations.find((entry) => entry.sha256 === sha);
        expect(row?.note).toBe('lovely crema');
        expect(row?.brew_output_g).toBeCloseTo(30, 5);
    });
});
