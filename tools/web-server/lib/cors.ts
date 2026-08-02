// Wildcard CORS applies ONLY to the bearer-key routes (device ingest and
// view-key share-link reads): those carry no cookies, so '*' is safe, and it
// lets a hosted dashboard read a self-hosted store cross-origin. The
// session-authed routes (Better Auth, store management, /api/me) are
// same-origin by design and deliberately get no CORS headers; their CSRF
// story is SameSite=Lax cookies + assertSameOrigin (lib/auth.ts).
export const CORS_HEADERS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type, x-device-id, x-source',
    'Access-Control-Max-Age': '86400',
};

export function withCors(response: Response): Response {
    for (const [key, value] of Object.entries(CORS_HEADERS)) {
        response.headers.set(key, value);
    }
    return response;
}

// Shared preflight handler; route files re-export it as OPTIONS.
export async function OPTIONS(): Promise<Response> {
    return withCors(new Response(null, { status: 204 }));
}
