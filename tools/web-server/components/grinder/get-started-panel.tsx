'use client';

// First-time USB install via esp-web-tools. Filling the `activate` slot with a
// real shadcn Button replaces the element's own trigger, so the page reads as
// ours. The install dialog it opens afterwards is esp-web-tools' own shadow-DOM
// UI and is not themable from here — the element only exposes custom properties
// for the fallback button we just replaced.
import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import Script from 'next/script';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { FirmwareSelect, useReleases } from './firmware-select';

export function GetStartedPanel({ onGoToWifi }: { onGoToWifi?: () => void }) {
    const { entries, error } = useReleases();
    const [showRc, setShowRc] = useState(false);
    const [tag, setTag] = useState('');

    const manifest = entries.find((entry) => entry.tag === tag)?.manifest ?? undefined;

    return (
        <div className="max-w-2xl">
            <Script
                type="module"
                src="https://unpkg.com/esp-web-tools@10/dist/web/install-button.js?module"
            />

            {error && (
                <p className="mb-6 text-destructive text-sm">
                    Couldn&apos;t load the firmware list: {error}
                </p>
            )}

            <div className="space-y-2">
                <Label htmlFor="usb-firmware">Firmware version</Label>
                <FirmwareSelect
                    id="usb-firmware"
                    entries={entries}
                    kind="manifest"
                    showPrereleases={showRc}
                    selectedTag={tag}
                    onSelect={setTag}
                />
                <div className="flex items-center gap-2 pt-1">
                    <Checkbox
                        id="usb-show-rc"
                        checked={showRc}
                        onCheckedChange={(checked) => setShowRc(checked === true)}
                    />
                    <Label htmlFor="usb-show-rc" className="font-normal text-muted-foreground">
                        Show release candidates
                    </Label>
                </div>
            </div>

            <div className="mt-6">
                <esp-web-install-button manifest={manifest}>
                    <Button slot="activate">Flash over USB</Button>
                    <span slot="unsupported" className="text-destructive text-sm">
                        This browser can&apos;t install over USB — Web Serial needs Chrome or Edge
                        on desktop.
                    </span>
                    <span slot="not-allowed" className="text-destructive text-sm">
                        Installing only works over HTTPS or on localhost.
                    </span>
                </esp-web-install-button>
            </div>

            <p className="mt-3 text-muted-foreground text-xs">
                Connect the board over USB-C and pick its serial port when prompted. This only has
                to happen once — every update after that goes over Bluetooth.
            </p>

            <p className="mt-8 border-t pt-6 text-sm">
                {onGoToWifi ? (
                    <button
                        type="button"
                        onClick={onGoToWifi}
                        className="inline-flex items-center gap-1.5 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    >
                        Flashed successfully? Set up WiFi so the clock stays synced
                        <ArrowRight className="size-3.5" />
                    </button>
                ) : (
                    <Link
                        href="/grinder/wifi"
                        className="inline-flex items-center gap-1.5 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    >
                        Flashed successfully? Set up WiFi so the clock stays synced
                        <ArrowRight className="size-3.5" />
                    </Link>
                )}
            </p>
        </div>
    );
}
