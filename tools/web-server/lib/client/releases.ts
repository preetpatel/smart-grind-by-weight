'use client';

// Client access to the firmware release index served by /api/firmware.
import type { FirmwareEntry } from '@/lib/firmware';

export type { FirmwareEntry };

let cached: Promise<FirmwareEntry[]> | null = null;

export function fetchReleases(): Promise<FirmwareEntry[]> {
    if (!cached) {
        cached = fetch('/api/firmware', { cache: 'no-store' }).then(async (response) => {
            if (!response.ok) {
                cached = null;
                throw new Error(`Failed to load firmware index (${response.status})`);
            }
            return (await response.json()) as FirmwareEntry[];
        });
    }
    return cached;
}

export function latestStable(entries: FirmwareEntry[]): FirmwareEntry | null {
    return entries.find((entry) => !entry.prerelease) ?? null;
}

// "1.7.0" vs "1.6.0-rc.1" → positive when a is newer. Prerelease of the same
// numeric version sorts below its release.
export function compareVersions(a: string, b: string): number {
    const parse = (v: string) => {
        const [main = '', pre] = String(v).replace(/^v/, '').split('-');
        return { nums: main.split('.').map((n) => Number.parseInt(n, 10) || 0), pre: pre ?? null };
    };
    const va = parse(a);
    const vb = parse(b);
    for (let i = 0; i < 3; i++) {
        const diff = (va.nums[i] ?? 0) - (vb.nums[i] ?? 0);
        if (diff) return diff;
    }
    if (!va.pre && vb.pre) return 1;
    if (va.pre && !vb.pre) return -1;
    if (va.pre && vb.pre) return va.pre.localeCompare(vb.pre);
    return 0;
}
