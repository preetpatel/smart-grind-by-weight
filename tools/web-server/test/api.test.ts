import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/lib/db';
import { api, freshDb, newStore, signUp } from './helpers/api';
import { buildSessionBlob } from './helpers/blob';

interface SessionSummaryWire {
    sha256: string;
    device_id: string | null;
    session_id: number;
    final_weight: number;
    result_status: string;
}

async function listedSessions(storeId: string, key: string): Promise<SessionSummaryWire[]> {
    const response = await api.listSessions(storeId, { key });
    const { sessions } = (await response.json()) as { sessions: SessionSummaryWire[] };
    return sessions;
}

let db: Db;
beforeEach(async () => {
    db = await freshDb();
});
afterEach(() => {
    for (const name of Object.keys(process.env)) {
        if (name.startsWith('SYNC_')) delete process.env[name];
    }
});

describe('store lifecycle', () => {
    it('creates a store for a signed-in account and returns keys exactly once', async () => {
        const store = await newStore();
        expect(store.store_id).toMatch(/^st_/);
        expect(store.upload_key).toMatch(/^uk_/);
        expect(store.view_key).toMatch(/^vk_/);

        const meta = await (await api.getStore(store.store_id, { key: store.view_key })).json();
        expect(meta.session_count).toBe(0);
        expect(meta.role).toBe('read');
    });

    it('requires a session to create a store', async () => {
        expect((await api.createStore()).status).toBe(401);
    });

    it('rejects cross-origin session mutations', async () => {
        const cookie = await signUp();
        const response = await api.createStore({
            cookie,
            headers: { origin: 'https://evil.example' },
        });
        expect(response.status).toBe(403);
    });

    it('rejects unknown stores and bad keys', async () => {
        const store = await newStore();
        expect((await api.getStore('st_nope', { key: store.view_key })).status).toBe(404);
        expect((await api.getStore(store.store_id, { key: 'uk_wrong' })).status).toBe(403);
        expect((await api.getStore(store.store_id, {})).status).toBe(401);
    });

    it('caps stores per account', async () => {
        process.env.SYNC_STORES_PER_USER = '2';
        const cookie = await signUp();
        expect((await api.createStore({ cookie })).status).toBe(201);
        expect((await api.createStore({ cookie })).status).toBe(201);
        expect((await api.createStore({ cookie })).status).toBe(429);
        // A different account is unaffected.
        expect((await api.createStore({ cookie: await signUp() })).status).toBe(201);
    });

    it('deletes a store with cascade, owner session only', async () => {
        const store = await newStore();
        await api.ingest(store.store_id, { key: store.upload_key, body: buildSessionBlob() });
        // Keys never grant store management.
        expect((await api.deleteStore(store.store_id, { key: store.view_key })).status).toBe(401);
        expect((await api.deleteStore(store.store_id, { key: store.upload_key })).status).toBe(401);
        // Neither does someone else's session.
        expect((await api.deleteStore(store.store_id, { cookie: await signUp() })).status).toBe(
            403,
        );
        expect((await api.deleteStore(store.store_id, { cookie: store.cookie })).status).toBe(200);
        expect((await api.getStore(store.store_id, { key: store.view_key })).status).toBe(404);
        const { rows } = await db.execute(sql`SELECT count(*)::int AS n FROM sessions`);
        expect(rows[0]?.n).toBe(0);
    });

    it('rotates the view key without touching the upload key', async () => {
        const store = await newStore();
        expect((await api.rotateViewKey(store.store_id, { key: store.upload_key })).status).toBe(
            401,
        );
        const { view_key: fresh } = (await (
            await api.rotateViewKey(store.store_id, { cookie: store.cookie })
        ).json()) as { view_key: string };
        expect((await api.getStore(store.store_id, { key: store.view_key })).status).toBe(403);
        expect((await api.getStore(store.store_id, { key: fresh })).status).toBe(200);
        expect((await api.getStore(store.store_id, { key: store.upload_key })).status).toBe(200);
    });

    it('renames a store, owner only', async () => {
        const store = await newStore();
        expect(
            (
                await api.patchStore(store.store_id, {
                    cookie: store.cookie,
                    body: { name: 'Kitchen grinder' },
                })
            ).status,
        ).toBe(200);
        const meta = await (await api.getStore(store.store_id, { key: store.view_key })).json();
        expect(meta.name).toBe('Kitchen grinder');
        expect(
            (await api.patchStore(store.store_id, { key: store.upload_key, body: { name: 'x' } }))
                .status,
        ).toBe(401);
    });
});

describe('accounts', () => {
    it('lists the account stores with session counts', async () => {
        const cookie = await signUp();
        const store = await newStore(cookie);
        await newStore(); // someone else's store — must not appear
        await api.ingest(store.store_id, { key: store.upload_key, body: buildSessionBlob() });

        const { stores } = (await (await api.myStores({ cookie })).json()) as {
            stores: { store_id: string; view_key: string; session_count: number }[];
        };
        expect(stores).toHaveLength(1);
        expect(stores[0]?.store_id).toBe(store.store_id);
        expect(stores[0]?.view_key).toBe(store.view_key);
        expect(stores[0]?.session_count).toBe(1);
        expect((await api.myStores({})).status).toBe(401);
    });

    it('grants the owner session read and write on store data', async () => {
        const store = await newStore();
        // Browser backfill with a session cookie, no bearer key.
        const ingest = await api.ingest(store.store_id, {
            cookie: store.cookie,
            body: buildSessionBlob({ sessionId: 5 }),
            headers: { 'x-source': 'browser' },
        });
        expect(ingest.status).toBe(201);
        const list = await api.listSessions(store.store_id, { cookie: store.cookie });
        expect(list.status).toBe(200);
        const meta = await (await api.getStore(store.store_id, { cookie: store.cookie })).json();
        expect(meta.role).toBe('write');
        // A stranger's session falls through to key auth and fails.
        expect((await api.getStore(store.store_id, { cookie: await signUp() })).status).toBe(401);
    });

    it('provisioning rotates the upload key and keeps the view key', async () => {
        const store = await newStore();
        expect((await api.provision(store.store_id, { key: store.upload_key })).status).toBe(401);

        const fresh = (await (
            await api.provision(store.store_id, { cookie: store.cookie })
        ).json()) as { store_id: string; upload_key: string; view_key: string };
        expect(fresh.view_key).toBe(store.view_key);
        expect(fresh.upload_key).not.toBe(store.upload_key);

        // The old device credential is dead; the fresh one works.
        expect(
            (await api.ingest(store.store_id, { key: store.upload_key, body: buildSessionBlob() }))
                .status,
        ).toBe(403);
        expect(
            (await api.ingest(store.store_id, { key: fresh.upload_key, body: buildSessionBlob() }))
                .status,
        ).toBe(201);
    });

    it('deleting the account cascades to stores and sessions', async () => {
        const store = await newStore();
        await api.ingest(store.store_id, { key: store.upload_key, body: buildSessionBlob() });
        await db.execute(sql`DELETE FROM "user"`);
        expect((await api.getStore(store.store_id, { key: store.view_key })).status).toBe(404);
        const { rows } = await db.execute(sql`SELECT count(*)::int AS n FROM sessions`);
        expect(rows[0]?.n).toBe(0);
    });
});

describe('session ingest', () => {
    it('stores a session, then drops the byte-identical re-upload', async () => {
        const store = await newStore();
        const blob = buildSessionBlob({ sessionId: 42 });

        const first = await api.ingest(store.store_id, {
            key: store.upload_key,
            body: blob,
            headers: { 'x-device-id': 'aabbccddeeff' },
        });
        expect(first.status).toBe(201);
        expect((await first.json()).status).toBe('stored');

        const second = await api.ingest(store.store_id, { key: store.upload_key, body: blob });
        expect(second.status).toBe(200);
        expect((await second.json()).status).toBe('duplicate');

        const sessions = await listedSessions(store.store_id, store.view_key);
        expect(sessions).toHaveLength(1);
        expect(sessions[0]?.session_id).toBe(42);
        expect(sessions[0]?.device_id).toBe('aabbccddeeff');
        expect(sessions[0]?.final_weight).toBeCloseTo(18.02, 2);
        expect(sessions[0]?.result_status).toBe('COMPLETE');
    });

    it('keeps a reborn session id (factory reset) as a distinct session', async () => {
        const store = await newStore();
        await api.ingest(store.store_id, {
            key: store.upload_key,
            body: buildSessionBlob({ sessionId: 42, timestamp: 1754000000 }),
        });
        await api.ingest(store.store_id, {
            key: store.upload_key,
            body: buildSessionBlob({ sessionId: 42, timestamp: 900 }),
        });
        expect(await listedSessions(store.store_id, store.view_key)).toHaveLength(2);
    });

    it('returns the exact bytes back from the blob endpoint', async () => {
        const store = await newStore();
        const blob = buildSessionBlob({ sessionId: 7, checksum: 'crc32' });
        const { sha256 } = (await (
            await api.ingest(store.store_id, { key: store.upload_key, body: blob })
        ).json()) as { sha256: string };
        const response = await api.getBlob(store.store_id, sha256, { key: store.view_key });
        expect(response.status).toBe(200);
        const roundTripped = new Uint8Array(await response.arrayBuffer());
        expect(roundTripped).toEqual(new Uint8Array(blob));
    });

    it('rejects writes with the view key', async () => {
        const store = await newStore();
        const response = await api.ingest(store.store_id, {
            key: store.view_key,
            body: buildSessionBlob(),
        });
        expect(response.status).toBe(403);
    });

    it('rejects corrupt and oversized uploads before storage', async () => {
        const store = await newStore();
        const cases = [
            buildSessionBlob({ corruptEventSequence: true }),
            buildSessionBlob({ corruptMeasurementSequence: true }),
            buildSessionBlob().slice(0, 200), // truncated
            buildSessionBlob({ checksum: 12345 }), // bad CRC
        ];
        for (const body of cases) {
            const response = await api.ingest(store.store_id, { key: store.upload_key, body });
            expect([413, 422]).toContain(response.status);
        }
        // Valid CRC32 is accepted.
        const ok = await api.ingest(store.store_id, {
            key: store.upload_key,
            body: buildSessionBlob({ checksum: 'crc32' }),
        });
        expect(ok.status).toBe(201);
        expect(await listedSessions(store.store_id, store.view_key)).toHaveLength(1);
    });

    it('rotates the oldest sessions past the quota', async () => {
        process.env.SYNC_SESSION_QUOTA = '3';
        const store = await newStore();
        for (let i = 1; i <= 5; i++) {
            const response = await api.ingest(store.store_id, {
                key: store.upload_key,
                body: buildSessionBlob({ sessionId: i }),
            });
            expect(response.status).toBe(201);
        }
        const sessions = await listedSessions(store.store_id, store.view_key);
        expect(sessions.map((s) => s.session_id)).toEqual([3, 4, 5]);
    });

    it('rate-limits uploads per store per hour', async () => {
        process.env.SYNC_UPLOADS_PER_HOUR = '2';
        const store = await newStore();
        const upload = (sessionId: number) =>
            api.ingest(store.store_id, {
                key: store.upload_key,
                body: buildSessionBlob({ sessionId }),
            });
        expect((await upload(1)).status).toBe(201);
        expect((await upload(2)).status).toBe(201);
        expect((await upload(3)).status).toBe(429);
    });
});

describe('manifest handshake', () => {
    it('requests only sessions the server does not hold', async () => {
        const store = await newStore();
        const held = buildSessionBlob({ sessionId: 10, timestamp: 1754000100 });
        await api.ingest(store.store_id, { key: store.upload_key, body: held });
        const heldSize = held.byteLength - 24;

        const response = await api.postManifest(store.store_id, {
            key: store.upload_key,
            body: {
                sessions: [
                    {
                        session_id: 10,
                        session_timestamp: 1754000100,
                        session_size: heldSize,
                        checksum: 0,
                    },
                    {
                        session_id: 11,
                        session_timestamp: 1754000200,
                        session_size: heldSize,
                        checksum: 0,
                    },
                ],
            },
        });
        expect((await response.json()).want).toEqual([11]);
    });

    it('re-requests a reborn session id whose tuple changed', async () => {
        const store = await newStore();
        const blob = buildSessionBlob({ sessionId: 10, timestamp: 1754000100 });
        await api.ingest(store.store_id, { key: store.upload_key, body: blob });
        const response = await api.postManifest(store.store_id, {
            key: store.upload_key,
            body: {
                sessions: [
                    {
                        session_id: 10,
                        session_timestamp: 555,
                        session_size: blob.byteLength - 24,
                        checksum: 0,
                    },
                ],
            },
        });
        expect((await response.json()).want).toEqual([10]);
    });

    it('wants everything after a server wipe (self-healing)', async () => {
        const store = await newStore();
        const blob = buildSessionBlob({ sessionId: 10, timestamp: 1754000100 });
        await api.ingest(store.store_id, { key: store.upload_key, body: blob });
        await db.execute(sql`DELETE FROM sessions`);
        const response = await api.postManifest(store.store_id, {
            key: store.upload_key,
            body: {
                sessions: [
                    {
                        session_id: 10,
                        session_timestamp: 1754000100,
                        session_size: blob.byteLength - 24,
                        checksum: 0,
                    },
                ],
            },
        });
        expect((await response.json()).want).toEqual([10]);
    });

    it('validates the manifest shape', async () => {
        const store = await newStore();
        expect(
            (await api.postManifest(store.store_id, { key: store.upload_key, body: {} })).status,
        ).toBe(400);
        expect(
            (
                await api.postManifest(store.store_id, {
                    key: store.upload_key,
                    body: { sessions: [{ session_id: 'x' }] },
                })
            ).status,
        ).toBe(400);
    });
});

describe('snapshots', () => {
    it('stores and lists health snapshots newest-first', async () => {
        const store = await newStore();
        for (const version of ['1.5.0', '1.6.0']) {
            const response = await api.postSnapshot(store.store_id, {
                key: store.upload_key,
                body: { firmware_version: version, lifetime_grinds: 123 },
                headers: { 'x-device-id': 'aabbccddeeff' },
            });
            expect(response.status).toBe(201);
        }
        const { snapshots } = (await (
            await api.listSnapshots(store.store_id, { key: store.view_key })
        ).json()) as {
            snapshots: { device_id: string | null; data: { firmware_version: string } }[];
        };
        expect(snapshots).toHaveLength(2);
        expect(snapshots[0]?.data.firmware_version).toBe('1.6.0');
        expect(snapshots[0]?.device_id).toBe('aabbccddeeff');
    });

    it('rejects oversized and non-JSON snapshots', async () => {
        const store = await newStore();
        expect(
            (
                await api.postSnapshot(store.store_id, {
                    key: store.upload_key,
                    body: `{"pad":"${'x'.repeat(5000)}"}`,
                })
            ).status,
        ).toBe(413);
        expect(
            (await api.postSnapshot(store.store_id, { key: store.upload_key, body: 'not json' }))
                .status,
        ).toBe(400);
    });
});
