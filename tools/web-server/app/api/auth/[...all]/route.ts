// Better Auth handler mount. Deliberately no CORS wrapper: these routes are
// cookie-authed and same-origin only (Better Auth does its own origin/CSRF
// checking), unlike the bearer-key store routes.
import { toNextJsHandler } from 'better-auth/next-js';
import { getAuth } from '@/lib/auth-server';

export const { GET, POST } = toNextJsHandler(async (request: Request) =>
    (await getAuth()).handler(request),
);
