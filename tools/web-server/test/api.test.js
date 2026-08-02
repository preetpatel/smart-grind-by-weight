import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, api, newStore } from './helpers/api.js';
import { buildSessionBlob } from './helpers/blob.js';

let db;
beforeEach(async () => {
    db = await freshDb();
});
afterEach(() => {
    for (const name of Object.keys(process.env)) {
        if (name.startsWith('SYNC_')) delete process.env[name];
    }
});

describe('store lifecycle', () => {
    it('creates a store and returns keys exactly once', async () => {
        const store = await newStore();
        expect(store.store_id).toMatch(/^st_/);
        expect(store.upload_key).toMatch(/^uk_/);
        expect(store.view_key).toMatch(/^vk_/);

        const meta = await (await api.getStore(store.store_id, { key: store.view_key })).json();
        expect(meta.provisional).toBe(true);
        expect(meta.session_count).toBe(0);
        expect(meta.role).toBe('read');
    });

    it('rejects unknown stores and bad keys', async () => {
        const store = await newStore();
        expect((await api.getStore('st_nope', { key: store.view_key })).status).toBe(404);
        expect((await api.getStore(store.store_id, { key: 'uk_wrong' })).status).toBe(403);
        expect((await api.getStore(store.store_id, {})).status).toBe(401);
    });

    it('rate-limits store creation per IP', async () => {
        process.env.SYNC_STORES_PER_IP_PER_DAY = '2';
        const headers = { 'x-forwarded-for': '10.1.2.3' };
        expect((await api.createStore({ headers })).status).toBe(201);
        expect((await api.createStore({ headers })).status).toBe(201);
        expect((await api.createStore({ headers })).status).toBe(429);
        // A different IP is unaffected.
        expect((await api.createStore({ headers: { 'x-forwarded-for': '10.9.9.9' } })).status).toBe(201);
    });

    it('garbage-collects expired provisional stores but keeps confirmed ones', async () => {
        const stale = await newStore();
        const confirmed = await newStore();
        await api.ingest(confirmed.store_id, { key: confirmed.upload_key, body: buildSessionBlob() });
        await db.execute(sql`UPDATE stores SET created_at = now() - interval '3 days'`);

        await newStore(); // creation triggers the GC sweep
        expect((await api.getStore(stale.store_id, { key: stale.view_key })).status).toBe(404);
        expect((await api.getStore(confirmed.store_id, { key: confirmed.view_key })).status).toBe(200);
    });

    it('deletes a store with cascade, upload key only', async () => {
        const store = await newStore();
        await api.ingest(store.store_id, { key: store.upload_key, body: buildSessionBlob() });
        expect((await api.deleteStore(store.store_id, { key: store.view_key })).status).toBe(403);
        expect((await api.deleteStore(store.store_id, { key: store.upload_key })).status).toBe(200);
        expect((await api.getStore(store.store_id, { key: store.view_key })).status).toBe(404);
        const { rows } = await db.execute(sql`SELECT count(*)::int AS n FROM sessions`);
        expect(rows[0].n).toBe(0);
    });

    it('rotates the view key without touching the upload key', async () => {
        const store = await newStore();
        const { view_key: fresh } = await (await api.rotateViewKey(store.store_id, { key: store.upload_key })).json();
        expect((await api.getStore(store.store_id, { key: store.view_key })).status).toBe(403);
        expect((await api.getStore(store.store_id, { key: fresh })).status).toBe(200);
        expect((await api.getStore(store.store_id, { key: store.upload_key })).status).toBe(200);
        // View key cannot rotate itself.
        expect((await api.rotateViewKey(store.store_id, { key: fresh })).status).toBe(403);
    });
});

describe('session ingest', () => {
    it('stores a session, then drops the byte-identical re-upload', async () => {
        const store = await newStore();
        const blob = buildSessionBlob({ sessionId: 42 });

        const first = await api.ingest(store.store_id, {
            key: store.upload_key, body: blob, headers: { 'x-device-id': 'aabbccddeeff' },
        });
        expect(first.status).toBe(201);
        const stored = await first.json();
        expect(stored.status).toBe('stored');

        const second = await api.ingest(store.store_id, { key: store.upload_key, body: blob });
        expect(second.status).toBe(200);
        expect((await second.json()).status).toBe('duplicate');

        const { sessions } = await (await api.listSessions(store.store_id, { key: store.view_key })).json();
        expect(sessions).toHaveLength(1);
        expect(sessions[0].session_id).toBe(42);
        expect(sessions[0].device_id).toBe('aabbccddeeff');
        expect(sessions[0].final_weight).toBeCloseTo(18.02, 2);
        expect(sessions[0].result_status).toBe('COMPLETE');

        const meta = await (await api.getStore(store.store_id, { key: store.view_key })).json();
        expect(meta.provisional).toBe(false);
    });

    it('keeps a reborn session id (factory reset) as a distinct session', async () => {
        const store = await newStore();
        await api.ingest(store.store_id, { key: store.upload_key, body: buildSessionBlob({ sessionId: 42, timestamp: 1754000000 }) });
        await api.ingest(store.store_id, { key: store.upload_key, body: buildSessionBlob({ sessionId: 42, timestamp: 900 }) });
        const { sessions } = await (await api.listSessions(store.store_id, { key: store.view_key })).json();
        expect(sessions).toHaveLength(2);
    });

    it('returns the exact bytes back from the blob endpoint', async () => {
        const store = await newStore();
        const blob = buildSessionBlob({ sessionId: 7, checksum: 'crc32' });
        const { sha256 } = await (await api.ingest(store.store_id, { key: store.upload_key, body: blob })).json();
        const response = await api.getBlob(store.store_id, sha256, { key: store.view_key });
        expect(response.status).toBe(200);
        const roundTripped = new Uint8Array(await response.arrayBuffer());
        expect(roundTripped).toEqual(new Uint8Array(blob));
    });

    it('rejects writes with the view key', async () => {
        const store = await newStore();
        const response = await api.ingest(store.store_id, { key: store.view_key, body: buildSessionBlob() });
        expect(response.status).toBe(403);
    });

    it('rejects corrupt and oversized uploads before storage', async () => {
        const store = await newStore();
        const cases = [
            buildSessionBlob({ corruptEventSequence: true }),
            buildSessionBlob({ corruptMeasurementSequence: true }),
            buildSessionBlob().slice(0, 200),                       // truncated
            buildSessionBlob({ checksum: 12345 }),                  // bad CRC
        ];
        for (const body of cases) {
            const response = await api.ingest(store.store_id, { key: store.upload_key, body });
            expect([413, 422]).toContain(response.status);
        }
        // Valid CRC32 is accepted.
        const ok = await api.ingest(store.store_id, { key: store.upload_key, body: buildSessionBlob({ checksum: 'crc32' }) });
        expect(ok.status).toBe(201);
        const { sessions } = await (await api.listSessions(store.store_id, { key: store.view_key })).json();
        expect(sessions).toHaveLength(1);
    });

    it('rotates the oldest sessions past the quota', async () => {
        process.env.SYNC_SESSION_QUOTA = '3';
        const store = await newStore();
        for (let i = 1; i <= 5; i++) {
            const response = await api.ingest(store.store_id, {
                key: store.upload_key, body: buildSessionBlob({ sessionId: i }),
            });
            expect(response.status).toBe(201);
        }
        const { sessions } = await (await api.listSessions(store.store_id, { key: store.view_key })).json();
        expect(sessions.map((s) => s.session_id)).toEqual([3, 4, 5]);
    });

    it('rate-limits uploads per store per hour', async () => {
        process.env.SYNC_UPLOADS_PER_HOUR = '2';
        const store = await newStore();
        expect((await api.ingest(store.store_id, { key: store.upload_key, body: buildSessionBlob({ sessionId: 1 }) })).status).toBe(201);
        expect((await api.ingest(store.store_id, { key: store.upload_key, body: buildSessionBlob({ sessionId: 2 }) })).status).toBe(201);
        expect((await api.ingest(store.store_id, { key: store.upload_key, body: buildSessionBlob({ sessionId: 3 }) })).status).toBe(429);
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
                    { session_id: 10, session_timestamp: 1754000100, session_size: heldSize, checksum: 0 },
                    { session_id: 11, session_timestamp: 1754000200, session_size: heldSize, checksum: 0 },
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
            body: { sessions: [{ session_id: 10, session_timestamp: 555, session_size: blob.byteLength - 24, checksum: 0 }] },
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
            body: { sessions: [{ session_id: 10, session_timestamp: 1754000100, session_size: blob.byteLength - 24, checksum: 0 }] },
        });
        expect((await response.json()).want).toEqual([10]);
    });

    it('validates the manifest shape', async () => {
        const store = await newStore();
        expect((await api.postManifest(store.store_id, { key: store.upload_key, body: {} })).status).toBe(400);
        expect((await api.postManifest(store.store_id, {
            key: store.upload_key, body: { sessions: [{ session_id: 'x' }] },
        })).status).toBe(400);
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
        const { snapshots } = await (await api.listSnapshots(store.store_id, { key: store.view_key })).json();
        expect(snapshots).toHaveLength(2);
        expect(snapshots[0].data.firmware_version).toBe('1.6.0');
        expect(snapshots[0].device_id).toBe('aabbccddeeff');
    });

    it('rejects oversized and non-JSON snapshots', async () => {
        const store = await newStore();
        expect((await api.postSnapshot(store.store_id, {
            key: store.upload_key, body: `{"pad":"${'x'.repeat(5000)}"}`,
        })).status).toBe(413);
        expect((await api.postSnapshot(store.store_id, {
            key: store.upload_key, body: 'not json',
        })).status).toBe(400);
        // Snapshots alone don't confirm a provisional store.
        const meta = await (await api.getStore(store.store_id, { key: store.view_key })).json();
        expect(meta.provisional).toBe(true);
    });
});
