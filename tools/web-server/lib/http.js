// Small helpers shared by the API route handlers.

export function json(body, status = 200) {
    return Response.json(body, { status });
}

// Thrown by helpers to short-circuit a handler with an error response;
// handleErrors turns it into JSON.
export class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

export async function handleErrors(fn) {
    try {
        return await fn();
    } catch (error) {
        if (error instanceof ApiError) {
            return json({ error: error.message }, error.status);
        }
        console.error('API error:', error);
        return json({ error: 'internal error' }, 500);
    }
}

export function clientIp(request) {
    const forwarded = request.headers.get('x-forwarded-for');
    if (forwarded) return forwarded.split(',')[0].trim();
    return request.headers.get('x-real-ip') || 'unknown';
}

export function bearerKey(request) {
    const header = request.headers.get('authorization') || '';
    const match = header.match(/^Bearer\s+(\S+)$/i);
    return match ? match[1] : null;
}
