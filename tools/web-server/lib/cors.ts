// The API is bearer-key authed with no cookies, so a permissive CORS policy
// is safe and lets the GitHub Pages flasher call the hosted API during the
// migration period.
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
