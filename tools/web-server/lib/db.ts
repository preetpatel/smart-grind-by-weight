// Database access via Drizzle. Production runs node-postgres against
// DATABASE_URL (Neon / Vercel Postgres / the docker-compose container — all
// just connection strings) and applies the generated migrations in ./drizzle
// on first use per process, which suits serverless cold starts. Tests inject
// a PGlite-backed Drizzle instance through setDbForTests.
import path from 'node:path';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from './schema';

// The PGlite test database is structurally identical (same schema object,
// same query API); the test helper casts it to this type.
export type Db = NodePgDatabase<typeof schema>;

let injected: Db | null = null; // test override
let dbPromise: Promise<Db> | null = null;

export function setDbForTests(db: Db): void {
    injected = db;
    dbPromise = null;
}

export async function getDb(): Promise<Db> {
    if (injected) return injected;
    if (!dbPromise) {
        dbPromise = (async () => {
            const { drizzle } = await import('drizzle-orm/node-postgres');
            const { migrate } = await import('drizzle-orm/node-postgres/migrator');
            const { default: pg } = await import('pg');
            const schemaModule = await import('./schema');
            const connectionString = process.env.DATABASE_URL;
            if (!connectionString) throw new Error('DATABASE_URL is not set');
            const pool = new pg.Pool({ connectionString, max: 5 });
            const db = drizzle(pool, { schema: schemaModule });
            await migrate(db, { migrationsFolder: path.join(process.cwd(), 'drizzle') });
            return db;
        })();
    }
    return dbPromise;
}
