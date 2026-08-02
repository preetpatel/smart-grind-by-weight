// Drizzle schema for the cloud sync store. Design: docs/CLOUD_SYNC.md.
//
// The raw session blob is the source of truth (bytea; sessions are ≤64 KB).
// The scalar columns on `sessions` are a disposable summary index parsed at
// ingest — re-derivable from blobs at any time. Keys are stored hashed
// (sha256 hex); the plaintext exists only on the device and in the
// provisioning browser.
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

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

export const stores = pgTable('stores', {
    id: text('id').primaryKey(),
    uploadKeyHash: text('upload_key_hash').notNull(),
    viewKeyHash: text('view_key_hash').notNull(),
    name: text('name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdIp: text('created_ip'),
    // Null = provisional: garbage-collected if no session upload arrives
    // within the TTL (docs/CLOUD_SYNC.md "Auth model").
    firstUploadAt: timestamp('first_upload_at', { withTimezone: true }),
});

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

export type Store = typeof stores.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type SnapshotRow = typeof snapshots.$inferSelect;
