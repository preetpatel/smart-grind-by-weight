// Better Auth server instance (docs/CLOUD_SYNC.md "Auth model").
//
// Built lazily: the Drizzle db only exists via the async getDb() singleton
// (it migrates on first use), and tests swap the db for PGlite through
// setDbForTests — caching per db instance makes both work transparently.
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { passkey } from '@better-auth/passkey';
import { betterAuth } from 'better-auth';
import { nextCookies } from 'better-auth/next-js';
import { type Db, getDb } from './db';
import * as schema from './schema';

// The GitHub sign-in button only renders when a deployment provides an OAuth
// app; email/password (and passkeys on top) always work, so bare self-hosts
// need no external identity provider.
export function githubConfigured(): boolean {
    return Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
}

function buildAuth(db: Db) {
    return betterAuth({
        database: drizzleAdapter(db, {
            provider: 'pg',
            schema: {
                user: schema.user,
                session: schema.session,
                account: schema.account,
                verification: schema.verification,
                passkey: schema.passkey,
            },
        }),
        secret: process.env.BETTER_AUTH_SECRET,
        baseURL: process.env.BETTER_AUTH_URL,
        // No mail infrastructure: no verification emails, no password reset.
        // The sign-in UI says so and points at GitHub/passkeys as backup.
        emailAndPassword: { enabled: true },
        socialProviders: githubConfigured()
            ? {
                  github: {
                      // biome-ignore lint/style/noNonNullAssertion: guarded by githubConfigured()
                      clientId: process.env.GITHUB_CLIENT_ID!,
                      // biome-ignore lint/style/noNonNullAssertion: guarded by githubConfigured()
                      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
                  },
              }
            : {},
        user: { deleteUser: { enabled: true } },
        // nextCookies must stay last (it rewrites Set-Cookie for server actions).
        plugins: [passkey(), nextCookies()],
    });
}

export type Auth = ReturnType<typeof buildAuth>;

let cached: { db: Db; auth: Auth } | null = null;

export async function getAuth(): Promise<Auth> {
    const db = await getDb();
    if (!cached || cached.db !== db) cached = { db, auth: buildAuth(db) };
    return cached.auth;
}

export interface SessionUser {
    id: string;
    email: string;
    name: string;
}

// Resolves the signed-in user from the request's session cookie, if any.
export async function getSessionUser(request: Request): Promise<SessionUser | null> {
    const auth = await getAuth();
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) return null;
    const { id, email, name } = session.user;
    return { id, email, name };
}
