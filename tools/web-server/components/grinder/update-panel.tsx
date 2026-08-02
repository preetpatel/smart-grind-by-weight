'use client';

// Wireless firmware update over BLE. The flash takes minutes and can fail
// halfway, so progress and status stay in a fixed region on the page rather
// than a toast, and the destructive-ish action is a single unmistakable button.
import { Zap } from 'lucide-react';
import { useState } from 'react';
import { type StatusMessage, StatusRegion } from '@/components/status-region';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { connectAndFlash } from '@/lib/client/ota';
import { compareVersions, latestStable } from '@/lib/client/releases';
import { useGrinder } from '@/lib/client/use-grinder';
import { FirmwareSelect, useReleases } from './firmware-select';

export function UpdatePanel() {
    const { entries, error } = useReleases();
    const { supported, active } = useGrinder();
    const [showRc, setShowRc] = useState(false);
    const [tag, setTag] = useState('');
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<StatusMessage | null>(null);
    const [progress, setProgress] = useState<number | null>(null);

    const selected = entries.find((entry) => entry.tag === tag);
    const deviceVersion =
        typeof active?.snapshot?.system?.version === 'string'
            ? active.snapshot.system.version
            : null;
    const latest = latestStable(entries);
    const updateAvailable =
        latest && deviceVersion ? compareVersions(latest.version, deviceVersion) > 0 : null;

    const flash = async () => {
        if (!selected?.ota) {
            setStatus({ text: 'Pick a firmware version first.', kind: 'error' });
            return;
        }
        if (!supported) {
            setStatus({ text: 'Web Bluetooth is not supported in this browser.', kind: 'error' });
            return;
        }
        setBusy(true);
        try {
            await connectAndFlash(selected.ota, selected.version, {
                onStatus: (text, kind) => setStatus({ text, kind }),
                onProgress: setProgress,
            });
        } catch (flashError) {
            setStatus({
                text: `Flash failed: ${flashError instanceof Error ? flashError.message : flashError}`,
                kind: 'error',
            });
            console.error('Flash error:', flashError);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="max-w-2xl">
            {deviceVersion && latest && (
                <p className="mb-6 text-sm">
                    {updateAvailable ? (
                        <>
                            <span className="text-caution">v{latest.version} is available.</span>{' '}
                            <span className="text-muted-foreground">
                                Your grinder runs{' '}
                                <span className="font-mono">v{deviceVersion}</span>.
                            </span>
                        </>
                    ) : (
                        <span className="text-muted-foreground">
                            Up to date on <span className="font-mono">v{deviceVersion}</span>.
                        </span>
                    )}
                </p>
            )}

            {error && (
                <p className="mb-6 text-destructive text-sm">
                    Couldn&apos;t load the firmware list: {error}
                </p>
            )}

            <div className="space-y-2">
                <Label htmlFor="ota-firmware">Firmware version</Label>
                <FirmwareSelect
                    id="ota-firmware"
                    entries={entries}
                    kind="ota"
                    showPrereleases={showRc}
                    selectedTag={tag}
                    onSelect={setTag}
                />
                <div className="flex items-center gap-2 pt-1">
                    <Checkbox
                        id="ota-show-rc"
                        checked={showRc}
                        onCheckedChange={(checked) => setShowRc(checked === true)}
                    />
                    <Label htmlFor="ota-show-rc" className="font-normal text-muted-foreground">
                        Show release candidates
                    </Label>
                </div>
            </div>

            <Button className="mt-6" disabled={busy} onClick={flash}>
                <Zap />
                {busy ? 'Flashing…' : 'Connect & flash'}
            </Button>

            <p className="mt-3 text-muted-foreground text-xs">
                Keep the grinder powered and this tab open until it reboots. If the link drops
                mid-transfer the upload restarts itself, and a failed update rolls back to the
                previous firmware.
            </p>

            <div className="mt-6">
                <StatusRegion status={status} progress={progress} />
            </div>
        </div>
    );
}
