// Better Auth browser client (docs/CLOUD_SYNC.md "Auth model"). Same-origin:
// the app serves its own auth API, so no baseURL is needed.
import { passkeyClient } from '@better-auth/passkey/client';
import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({
    plugins: [passkeyClient()],
});

export type SessionUser = (typeof authClient.$Infer.Session)['user'];
