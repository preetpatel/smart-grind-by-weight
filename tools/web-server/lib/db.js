// Database access via Drizzle. Production runs node-postgres against
// DATABASE_URL (Neon / Vercel Postgres / the docker-compose container — all
// just connection strings) and applies the generated migrations in ./drizzle
// on first use per process, which suits serverless cold starts. Tests inject
// a PGlite-backed Drizzle instance through setDbForTests.
import path from 'node:path';

let injected = null; // test override
let dbPromise = null;

export function setDbForTests(db) {
    injected = db;
    dbPromise = null;
}

export async function getDb() {
    if (injected) return injected;
    if (!dbPromise) {
        dbPromise = (async () => {
            const { drizzle } = await import('drizzle-orm/node-postgres');
            const { migrate } = await import('drizzle-orm/node-postgres/migrator');
            const { default: pg } = await import('pg');
            const schema = await import('./schema.js');
            const connectionString = process.env.DATABASE_URL;
            if (!connectionString) throw new Error('DATABASE_URL is not set');
            const pool = new pg.Pool({ connectionString, max: 5 });
            const db = drizzle(pool, { schema });
            await migrate(db, { migrationsFolder: path.join(process.cwd(), 'drizzle') });
            return db;
        })();
    }
    return dbPromise;
}
