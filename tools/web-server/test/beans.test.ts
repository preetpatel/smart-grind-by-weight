// Beans, brew records and the advice engine: the bag registry, ingest-time
// attribution, the device's brew upload, and the finer/coarser verdict.
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveRecipe } from '@/lib/beans';
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

describe('recipe ranges', () => {
    it('stores the bag as typed and scales the yield band to the dose', () => {
        // The card: dose 20.5 g, yield 27-30 g, ratio 1:1.5. Note 20.5 x 1.5
        // is 30.75 — outside its own stated range — which is exactly why the
        // range is stored rather than derived from the ratio.
        const bean = {
            ratio: 1.5,
            doseG: 20.5,
            yieldMinG: 27,
            yieldMaxG: 30,
            timeMinS: 25,
            timeMaxS: 31,
        };
        const atBagDose = resolveRecipe(bean, 20.5);
        expect(atBagDose.yieldStated).toBe(true);
        expect(atBagDose.yieldMinG).toBeCloseTo(27, 5);
        expect(atBagDose.yieldMaxG).toBeCloseTo(30, 5);

        // An 18 g grind targets proportionally less.
        const smaller = resolveRecipe(bean, 18);
        expect(smaller.yieldMinG).toBeCloseTo(23.71, 2);
        expect(smaller.yieldMaxG).toBeCloseTo(26.34, 2);
        // Time is an absolute the roaster stated: it does not scale.
        expect(smaller.timeMinS).toBe(25);
        expect(smaller.timeMaxS).toBe(31);
    });

    it('falls back to a derived tolerance when the bag states no range', () => {
        const recipe = resolveRecipe(
            {
                ratio: 1.5,
                doseG: null,
                yieldMinG: null,
                yieldMaxG: null,
                timeMinS: null,
                timeMaxS: null,
            },
            18,
        );
        expect(recipe.yieldStated).toBe(false);
        expect(recipe.yieldMinG).toBeCloseTo(27 * 0.97, 5);
        expect(recipe.yieldMaxG).toBeCloseTo(27 * 1.03, 5);
        // No derived time band: a tolerance nobody stated is not invented.
        expect(recipe.timeMinS).toBeNull();
        expect(recipe.timeMaxS).toBeNull();
    });

    it('round-trips a recipe through create and patch', async () => {
        const store = await newStore();
        const created = await api.createBean(store.store_id, {
            cookie: store.cookie,
            body: {
                name: 'Atomic Veloce',
                ratio: 1.5,
                dose_g: 20.5,
                yield_min_g: 27,
                yield_max_g: 30,
                time_min_s: 25,
                time_max_s: 31,
            },
        });
        expect(created.status).toBe(201);
        const { bean } = (await created.json()) as { bean: Record<string, unknown> };
        expect(bean.dose_g).toBeCloseTo(20.5, 5);
        expect(bean.yield_max_g).toBeCloseTo(30, 5);
        expect(bean.time_min_s).toBe(25);

        // Clearing one edge of a pair is refused; clearing both is the way to
        // turn a range back off.
        const half = await api.patchBean(store.store_id, bean.id as string, {
            cookie: store.cookie,
            body: { time_min_s: null },
        });
        expect(half.status).toBe(400);

        const cleared = await api.patchBean(store.store_id, bean.id as string, {
            cookie: store.cookie,
            body: { time_min_s: null, time_max_s: null },
        });
        expect(cleared.status).toBe(200);
        const after = (await cleared.json()) as { bean: Record<string, unknown> };
        expect(after.bean.time_min_s).toBeNull();
        expect(after.bean.yield_min_g).toBeCloseTo(27, 5);
    });

    it('refuses an inverted range and a yield range with no dose behind it', async () => {
        const store = await newStore();
        const inverted = await api.createBean(store.store_id, {
            cookie: store.cookie,
            body: { name: 'Backwards', ratio: 1.5, dose_g: 18, yield_min_g: 30, yield_max_g: 27 },
        });
        expect(inverted.status).toBe(400);

        const doseless = await api.createBean(store.store_id, {
            cookie: store.cookie,
            body: { name: 'Unanchored', ratio: 1.5, yield_min_g: 27, yield_max_g: 30 },
        });
        expect(doseless.status).toBe(400);
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

    it('stores an unmeasured time as null rather than a default', async () => {
        const store = await newStore();
        await createBean(store.store_id, store.cookie);
        const skipped = await ingestBlob(store.store_id, store.upload_key, {
            sessionId: 7,
            timestamp: 1754000007,
        });
        const absent = await ingestBlob(store.store_id, store.upload_key, {
            sessionId: 8,
            timestamp: 1754000008,
        });

        // 0 is what the grinder sends when the user skips the time step; an
        // older firmware omits the field entirely. Neither may become a 30.
        const response = await api.postBrews(store.store_id, {
            key: store.upload_key,
            body: {
                brews: [
                    {
                        session_id: 7,
                        session_timestamp: 1754000007,
                        brew_output_g: 30.1,
                        brew_time_s: 0,
                    },
                    {
                        session_id: 8,
                        session_timestamp: 1754000008,
                        brew_output_g: 29.4,
                    },
                ],
            },
        });
        expect(response.status).toBe(200);

        const annotations = (await (
            await api.getAnnotations(store.store_id, { cookie: store.cookie })
        ).json()) as {
            annotations: {
                sha256: string;
                brew_output_g: number | null;
                brew_time_s: number | null;
            }[];
        };
        for (const sha of [skipped, absent]) {
            const row = annotations.annotations.find((entry) => entry.sha256 === sha);
            expect(row?.brew_time_s).toBeNull();
            expect(row?.brew_output_g).not.toBeNull();
        }
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
        // 0 = the user skipped the time step, which is how a shot reaches the
        // yield-deviation path even on a bean that states a target time.
        brewTimeS = 30,
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
                        brew_time_s: brewTimeS,
                    },
                ],
            },
        });
        return sha;
    }

    // The bag on the desk: dose 20.5 g, yield 27–30 g, time 25–31 s. The test
    // blob's dose is 18.02 g, so the yield band scales to ~23.7–26.4.
    const RECIPE = {
        dose_g: 20.5,
        yield_min_g: 27,
        yield_max_g: 30,
        time_min_s: 25,
        time_max_s: 31,
    };

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

    it('judges a timed shot on the clock, not the yield', async () => {
        const store = await newStore();
        await createBean(store.store_id, store.cookie, RECIPE);
        // Yield lands mid-band (~25 g), so normalisation is a no-op and the
        // 20 s clock is what falls short of the 25–31 s the bag asks for.
        await shotWithBrew(store, 1, 25, 20);
        await shotWithBrew(store, 2, 25, 21);
        await shotWithBrew(store, 3, 25, 19);

        const body = (await (
            await api.getConfig(store.store_id, { key: store.upload_key })
        ).json()) as {
            advice: { verdict: string; shots_considered: number; basis: string };
        };
        expect(body.advice.basis).toBe('time');
        expect(body.advice.verdict).toBe('finer');
        expect(body.advice.shots_considered).toBe(3);
    });

    it('advises coarser when timed shots run long', async () => {
        const store = await newStore();
        await createBean(store.store_id, store.cookie, RECIPE);
        await shotWithBrew(store, 1, 25, 38);
        await shotWithBrew(store, 2, 25, 36);
        await shotWithBrew(store, 3, 25, 40);

        const body = (await (
            await api.getConfig(store.store_id, { key: store.upload_key })
        ).json()) as { advice: { verdict: string; basis: string } };
        expect(body.advice.basis).toBe('time');
        expect(body.advice.verdict).toBe('coarser');
    });

    it('normalises the clock to the yield band, so a short shot is not read as fast', async () => {
        const store = await newStore();
        await createBean(store.store_id, store.cookie, RECIPE);
        // Stopped at 12.5 g — half the ~25 g target — in 14 s. Same flow as a
        // full 28 s shot, which is inside the band: no advice to give.
        await shotWithBrew(store, 1, 12.5, 14);
        await shotWithBrew(store, 2, 12.5, 14);
        await shotWithBrew(store, 3, 12.5, 14);

        const body = (await (
            await api.getConfig(store.store_id, { key: store.upload_key })
        ).json()) as { advice: { verdict: string; basis: string } };
        expect(body.advice.basis).toBe('time');
        expect(body.advice.verdict).toBe('ok');
    });

    it('falls back to yield deviation when the shots were never timed', async () => {
        const store = await newStore();
        await createBean(store.store_id, store.cookie, RECIPE);
        // The bag states a time, but nobody answered the time step. The clock
        // has nothing to say, and the untimed shots must not vote on it.
        await shotWithBrew(store, 1, 30.5, 0);
        await shotWithBrew(store, 2, 30.8, 0);
        await shotWithBrew(store, 3, 30.2, 0);

        const body = (await (
            await api.getConfig(store.store_id, { key: store.upload_key })
        ).json()) as { advice: { verdict: string; basis: string } };
        expect(body.advice.basis).toBe('yield');
        expect(body.advice.verdict).toBe('finer');
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

    it('tracks bag consumption and counts remaining shots in the user dose', async () => {
        const store = await newStore();
        const { bean } = await createBean(store.store_id, store.cookie, { bag_size_g: 250 });
        // Three ~18g doubles attributed at ingest → ~54g used.
        for (const sessionId of [1, 2, 3]) {
            await ingestBlob(store.store_id, store.upload_key, {
                sessionId,
                timestamp: 1754000000 + sessionId,
            });
        }

        const body = (await (
            await api.getConfig(store.store_id, { key: store.upload_key })
        ).json()) as {
            bag: { size_g: number; used_g: number; shots_remaining: number; low: boolean };
        };
        expect(body.bag.size_g).toBe(250);
        expect(body.bag.used_g).toBeCloseTo(54.1, 1);
        // ~195.9g left at a median 18.02g dose → 10 doubles.
        expect(body.bag.shots_remaining).toBe(10);
        expect(body.bag.low).toBe(false);

        // Shrink the bag under the threshold and the warning trips.
        const patched = await api.patchBean(store.store_id, bean.id, {
            cookie: store.cookie,
            body: { bag_size_g: 90 },
        });
        expect(patched.status).toBe(200);
        const lowBody = (await (
            await api.getConfig(store.store_id, { key: store.upload_key })
        ).json()) as { bag: { shots_remaining: number; low: boolean } };
        expect(lowBody.bag.shots_remaining).toBe(1);
        expect(lowBody.bag.low).toBe(true);
    });

    it('reports no bag stats when the bag size is unset', async () => {
        const store = await newStore();
        await createBean(store.store_id, store.cookie);
        await ingestBlob(store.store_id, store.upload_key);
        const body = (await (
            await api.getConfig(store.store_id, { key: store.upload_key })
        ).json()) as { bag: { size_g: null; used_g: number; shots_remaining: null } };
        expect(body.bag.size_g).toBeNull();
        expect(body.bag.shots_remaining).toBeNull();
        expect(body.bag.used_g).toBeGreaterThan(0);
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
