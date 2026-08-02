// Small helpers shared by the API route handlers.

export function json(body: unknown, status = 200): Response {
    return Response.json(body, { status });
}

// Thrown by helpers to short-circuit a handler with an error response;
// handleErrors turns it into JSON. `code` is for the few failures the UI has
// to tell apart to offer the right next step, not for every error.
export class ApiError extends Error {
    readonly status: number;
    readonly code: string | undefined;

    constructor(status: number, message: string, code?: string) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

export async function handleErrors(fn: () => Promise<Response>): Promise<Response> {
    try {
        return await fn();
    } catch (error) {
        if (error instanceof ApiError) {
            return json(
                error.code ? { error: error.message, code: error.code } : { error: error.message },
                error.status,
            );
        }
        console.error('API error:', error);
        return json({ error: 'internal error' }, 500);
    }
}

export function clientIp(request: Request): string {
    const forwarded = request.headers.get('x-forwarded-for');
    if (forwarded) return forwarded.split(',')[0]?.trim() ?? 'unknown';
    return request.headers.get('x-real-ip') ?? 'unknown';
}

export function bearerKey(request: Request): string | null {
    const header = request.headers.get('authorization') ?? '';
    const match = header.match(/^Bearer\s+(\S+)$/i);
    return match?.[1] ?? null;
}
