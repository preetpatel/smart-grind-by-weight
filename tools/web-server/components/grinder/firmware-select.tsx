'use client';

// Release picker shared by the USB install and OTA update panels.
import { useEffect, useState } from 'react';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
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
    id,
    entries,
    kind,
    showPrereleases,
    selectedTag,
    onSelect,
}: {
    id?: string;
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
            <Select disabled value="">
                <SelectTrigger id={id} className="w-full max-w-sm">
                    <span className="text-muted-foreground">
                        {entries.length ? 'No firmware available' : 'Loading releases…'}
                    </span>
                </SelectTrigger>
                <SelectContent />
            </Select>
        );
    }

    return (
        <Select
            value={selected}
            onValueChange={(value) => onSelect(value ?? '')}
            items={Object.fromEntries(
                visible.map((entry) => [
                    entry.tag,
                    entry.prerelease ? `${entry.display} (pre-release)` : entry.display,
                ]),
            )}
        >
            <SelectTrigger id={id} className="w-full max-w-sm font-mono">
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                {visible.map((entry) => (
                    <SelectItem key={entry.tag} value={entry.tag} className="font-mono">
                        {entry.prerelease ? `${entry.display} (pre-release)` : entry.display}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
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
