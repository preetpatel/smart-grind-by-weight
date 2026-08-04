// Drizzle schema for the cloud sync store. Design: docs/CLOUD_SYNC.md.
//
// The raw session blob is the source of truth (bytea; sessions are ≤64 KB).
// The scalar columns on `sessions` are a disposable summary index parsed at
// ingest — re-derivable from blobs at any time. upload_key is stored hashed
// (sha256 hex) and rotated on every device provision, so its plaintext exists
// only on the device; view_key is stored plaintext by design — it is the
// semi-public read credential that share links and the device's BLE status
// characteristic hand out.
import { sql } from 'drizzle-orm';
import {
    bigint,
    bigserial,
    customType,
    index,
    integer,
    jsonb,
    pgTable,
    real,
    smallint,
    text,
    timestamp,
    uniqueIndex,
} from 'drizzle-orm/pg-core';
import { user } from './auth-schema';

export * from './auth-schema';

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

export const stores = pgTable(
    'stores',
    {
        id: text('id').primaryKey(),
        // Every store is owned by an account from birth; deleting the account
        // cascades through stores to sessions and snapshots.
        ownerId: text('owner_id')
            .notNull()
            .references(() => user.id, { onDelete: 'cascade' }),
        uploadKeyHash: text('upload_key_hash').notNull(),
        viewKey: text('view_key').notNull(),
        name: text('name'),
        // The grinder this store belongs to (its factory MAC, which the
        // firmware already sends as x-device-id on every request). One
        // grinder, one store — enforced here rather than by UI etiquette, so
        // no browser without the right localStorage can mint a second one.
        // NULL means unbound: an archive whose grinder was released or
        // claimed by another account, still readable by its owner.
        deviceId: text('device_id'),
        // The bag currently in the hopper. Soft reference to beans.id — beans
        // already FK back to stores, and a cycle of constraints buys nothing
        // the activate/delete routes don't enforce.
        activeBeanId: text('active_bean_id'),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        index('stores_owner_idx').on(table.ownerId),
        uniqueIndex('stores_device_uq')
            .on(table.deviceId)
            .where(sql`${table.deviceId} is not null`),
    ],
);

export const sessions = pgTable(
    'sessions',
    {
        id: bigserial('id', { mode: 'number' }).primaryKey(),
        storeId: text('store_id')
            .notNull()
            .references(() => stores.id, { onDelete: 'cascade' }),
        deviceId: text('device_id'),
        sha256: text('sha256').notNull(),
        source: text('source').notNull().default('device'),
        receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
        // Header fields; all fit in uint32 so 'number' mode is safe.
        sessionId: bigint('session_id', { mode: 'number' }).notNull(),
        sessionTimestamp: bigint('session_timestamp', { mode: 'number' }).notNull(),
        sessionSize: integer('session_size').notNull(),
        headerChecksum: bigint('header_checksum', { mode: 'number' }).notNull(),
        schemaVersion: integer('schema_version').notNull(),
        eventCount: integer('event_count').notNull(),
        measurementCount: integer('measurement_count').notNull(),
        // GrindSession summary index
        grindMode: smallint('grind_mode'),
        profileId: smallint('profile_id'),
        targetWeight: real('target_weight'),
        finalWeight: real('final_weight'),
        errorGrams: real('error_grams'),
        targetTimeMs: bigint('target_time_ms', { mode: 'number' }),
        totalTimeMs: bigint('total_time_ms', { mode: 'number' }),
        totalMotorOnTimeMs: bigint('total_motor_on_time_ms', { mode: 'number' }),
        timeErrorMs: bigint('time_error_ms', { mode: 'number' }),
        pulseCount: smallint('pulse_count'),
        terminationReason: smallint('termination_reason'),
        resultStatus: text('result_status'),
        blob: bytea('blob').notNull(),
    },
    (table) => [
        uniqueIndex('sessions_store_sha_uq').on(table.storeId, table.sha256),
        index('sessions_store_received_idx').on(table.storeId, table.receivedAt, table.id),
        index('sessions_store_session_idx').on(table.storeId, table.sessionId),
    ],
);

export const snapshots = pgTable(
    'snapshots',
    {
        id: bigserial('id', { mode: 'number' }).primaryKey(),
        storeId: text('store_id')
            .notNull()
            .references(() => stores.id, { onDelete: 'cascade' }),
        deviceId: text('device_id'),
        receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
        data: jsonb('data').notNull(),
    },
    (table) => [
        index('snapshots_store_received_idx').on(table.storeId, table.receivedAt, table.id),
    ],
);

// A bean is one bag of coffee: the brew ratio and shot time the grinder should
// expect while it's active, plus the roast date trends group by. Rows are kept
// after the bag is finished (archived_at) so per-bag history survives.
export const beans = pgTable(
    'beans',
    {
        id: text('id').primaryKey(),
        storeId: text('store_id')
            .notNull()
            .references(() => stores.id, { onDelete: 'cascade' }),
        name: text('name').notNull(),
        // Output per gram of dose: 1.5 means a 1 : 1.5 ratio.
        ratio: real('ratio').notNull(),
        brewTimeS: integer('brew_time_s').notNull().default(30),
        // What the bag states, as typed. A bag gives a recipe — "dose 20.5 g,
        // yield 27–30 g, time 25–31 s" — and those numbers routinely disagree
        // with its own printed ratio (20.5 × 1.5 = 30.75, outside 27–30), so a
        // range stored as a ratio range would quietly rewrite the roaster.
        // Null throughout for beans carrying only a ratio, which fall back to
        // dose × ratio with a derived tolerance.
        doseG: real('dose_g'),
        yieldMinG: real('yield_min_g'),
        yieldMaxG: real('yield_max_g'),
        timeMinS: integer('time_min_s'),
        timeMaxS: integer('time_max_s'),
        // How much coffee the bag held when opened. Optional: null disables
        // remaining-shots tracking for this bag.
        bagSizeG: real('bag_size_g'),
        roastDate: text('roast_date'),
        notes: text('notes'),
        archivedAt: timestamp('archived_at', { withTimezone: true }),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [index('beans_store_idx').on(table.storeId)],
);

// What the grinder can't know: which beans went in and what the burrs were set
// to. Keyed by the session's content hash rather than a foreign key, so an
// annotation written before a session finishes uploading still lands on it, and
// survives the row being re-ingested. Local-first in the browser (IndexedDB);
// this table is the copy that follows an account across browsers, reconciled
// last-write-wins on updatedAt.
export const annotations = pgTable(
    'annotations',
    {
        id: bigserial('id', { mode: 'number' }).primaryKey(),
        storeId: text('store_id')
            .notNull()
            .references(() => stores.id, { onDelete: 'cascade' }),
        sha256: text('sha256').notNull(),
        bean: text('bean'),
        roastDate: text('roast_date'),
        grindSetting: text('grind_setting'),
        note: text('note'),
        tags: jsonb('tags').$type<string[]>().notNull().default([]),
        // Which bag was in the hopper (soft reference to beans.id — a deleted
        // bean or a viewer import must not invalidate the row), and what the
        // shot yielded: grams out over brew_time_s seconds. Not re-derivable
        // from session blobs, which is why it lives here and not on sessions.
        beanId: text('bean_id'),
        brewOutputG: real('brew_output_g'),
        brewTimeS: integer('brew_time_s'),
        updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        uniqueIndex('annotations_store_sha_uq').on(table.storeId, table.sha256),
        index('annotations_store_updated_idx').on(table.storeId, table.updatedAt),
        index('annotations_store_bean_idx').on(table.storeId, table.beanId),
    ],
);

// Deleting a session has to outlive the next sync: the manifest handshake is
// stateless, so without a tombstone the grinder simply uploads it again. Rows
// here are consulted by the manifest and by ingest.
export const deletedSessions = pgTable(
    'deleted_sessions',
    {
        id: bigserial('id', { mode: 'number' }).primaryKey(),
        storeId: text('store_id')
            .notNull()
            .references(() => stores.id, { onDelete: 'cascade' }),
        sha256: text('sha256').notNull(),
        // The manifest identifies files by (session_id, timestamp), not hash —
        // the device has not uploaded the bytes yet, so it cannot know the
        // hash. Both are recorded so either side can be matched.
        sessionId: bigint('session_id', { mode: 'number' }).notNull(),
        sessionTimestamp: bigint('session_timestamp', { mode: 'number' }).notNull(),
        deletedAt: timestamp('deleted_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        uniqueIndex('deleted_sessions_store_sha_uq').on(table.storeId, table.sha256),
        index('deleted_sessions_store_session_idx').on(
            table.storeId,
            table.sessionId,
            table.sessionTimestamp,
        ),
    ],
);

export type Store = typeof stores.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type SnapshotRow = typeof snapshots.$inferSelect;
export type AnnotationRow = typeof annotations.$inferSelect;
export type DeletedSessionRow = typeof deletedSessions.$inferSelect;
export type BeanRow = typeof beans.$inferSelect;
