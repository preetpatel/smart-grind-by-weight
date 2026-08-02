import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// Prefixes make a leaked key self-identifying in logs and support tickets.
export function newStoreId(): string {
    return `st_${randomBytes(8).toString('hex')}`;
}
export function newUploadKey(): string {
    return `uk_${randomBytes(16).toString('hex')}`;
}
export function newViewKey(): string {
    return `vk_${randomBytes(16).toString('hex')}`;
}

export function hashKey(key: string): string {
    return createHash('sha256').update(key, 'utf8').digest('hex');
}

// Constant-time credential comparison. Both inputs are re-hashed so the
// timing is independent of attacker-controlled input length.
export function keysEqual(a: string, b: string): boolean {
    const bufA = createHash('sha256').update(a, 'utf8').digest();
    const bufB = createHash('sha256').update(b, 'utf8').digest();
    return timingSafeEqual(bufA, bufB);
}

export function sha256Hex(buffer: Buffer | Uint8Array): string {
    return createHash('sha256').update(buffer).digest('hex');
}
