import { createHash, randomBytes } from 'node:crypto';

// Prefixes make a leaked key self-identifying in logs and support tickets.
export function newStoreId() { return `st_${randomBytes(8).toString('hex')}`; }
export function newUploadKey() { return `uk_${randomBytes(16).toString('hex')}`; }
export function newViewKey() { return `vk_${randomBytes(16).toString('hex')}`; }

export function hashKey(key) {
    return createHash('sha256').update(key, 'utf8').digest('hex');
}

export function sha256Hex(buffer) {
    return createHash('sha256').update(buffer).digest('hex');
}
