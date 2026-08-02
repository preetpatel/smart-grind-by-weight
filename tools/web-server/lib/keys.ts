import { createHash, randomBytes } from 'node:crypto';

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

export function sha256Hex(buffer: Buffer | Uint8Array): string {
    return createHash('sha256').update(buffer).digest('hex');
}
