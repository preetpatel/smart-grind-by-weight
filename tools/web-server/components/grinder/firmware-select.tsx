'use client';

// Release dropdown shared by the USB install and OTA update panels.
import { useEffect, useState } from 'react';
import { type FirmwareEntry, fetchReleases } from '@/lib/client/releases';

export function useReleases(): { entries: FirmwareEntry[]; error: string | null } {
    const [entries, setEntries] = useState<FirmwareEntry[]>([]);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        fetchReleases()
            .then(setEntries)
            .catch((e: Error) => setError(e.message));
    }, []);
    return { entries, error };
}

export function FirmwareSelect({
    entries,
    kind,
    showPrereleases,
    selectedTag,
    onSelect,
}: {
    entries: FirmwareEntry[];
    kind: 'manifest' | 'ota';
    showPrereleases: boolean;
    selectedTag: string;
    onSelect: (tag: string) => void;
}) {
    const visible = entries.filter(
        (entry) => entry[kind] && (!entry.prerelease || showPrereleases),
    );
    // Keep the selection valid as filters change; default to the newest.
    const selected = visible.some((entry) => entry.tag === selectedTag)
        ? selectedTag
        : (visible[0]?.tag ?? '');
    useEffectiveSelection(selected, selectedTag, onSelect);

    if (!visible.length) {
        return (
            <select disabled>
                <option>{entries.length ? 'No firmware available' : 'Loading releases…'}</option>
            </select>
        );
    }
    return (
        <select value={selected} onChange={(e) => onSelect(e.target.value)}>
            {visible.map((entry) => (
                <option key={entry.tag} value={entry.tag}>
                    {entry.prerelease ? `${entry.display} (pre-release)` : entry.display}
                </option>
            ))}
        </select>
    );
}

// Push the effective (possibly defaulted) selection back up exactly when it
// differs, so parents always hold a valid tag.
function useEffectiveSelection(
    effective: string,
    current: string,
    onSelect: (tag: string) => void,
): void {
    useEffect(() => {
        if (effective && effective !== current) onSelect(effective);
    }, [effective, current, onSelect]);
}
