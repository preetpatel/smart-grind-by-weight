'use client';

// The front door, and the only page that changes shape depending on whether
// this browser has ever met a grinder. New visitor: the install path, stated
// plainly. Returning owner: what the device's last snapshot says, with each
// fact linking to the page that can act on it.
import { ArrowRight, Usb, Zap } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { StatRow, StatValue } from '@/components/stat-row';
import { Button } from '@/components/ui/button';
import { UnsupportedBrowser } from '@/components/unsupported-browser';
import * as ble from '@/lib/client/ble';
import { compareVersions, fetchReleases, latestStable } from '@/lib/client/releases';
import { useGrinder } from '@/lib/client/use-grinder';

function relativeLabel(ts: number | undefined): string {
    if (!ts) return 'never';
    const minutes = Math.floor((Date.now() - ts) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

function FirstRun({ supported }: { supported: boolean }) {
    const [busy, setBusy] = useState(false);

    return (
        <>
            <PageHeader title="Set up your grinder" />
            <UnsupportedBrowser />

            <div className="max-w-2xl space-y-8">
                <section className="space-y-3">
                    <h2 className="font-medium text-base">Already flashed?</h2>
                    <Button
                        disabled={!supported || busy}
                        onClick={async () => {
                            setBusy(true);
                            try {
                                await ble.addGrinder();
                            } catch (error) {
                                if ((error as Error).name !== 'NotFoundError') {
                                    const { toast } = await import('sonner');
                                    toast.error((error as Error).message);
                                }
                            } finally {
                                setBusy(false);
                            }
                        }}
                    >
                        Connect grinder
                    </Button>
                </section>

                <section className="space-y-3 border-t pt-8">
                    <h2 className="font-medium text-base">Brand new board?</h2>
                    <Button
                        variant="outline"
                        nativeButton={false}
                        render={<Link href="/grinder/get-started" />}
                    >
                        <Usb />
                        Install over USB
                    </Button>
                </section>
            </div>
        </>
    );
}

export default function HomePage() {
    const { supported, connected, active } = useGrinder();
    const [latestVersion, setLatestVersion] = useState<string | null>(null);
    const [mounted, setMounted] = useState(false);

    useEffect(() => setMounted(true), []);
    useEffect(() => {
        fetchReleases()
            .then((entries) => setLatestVersion(latestStable(entries)?.version ?? null))
            .catch(() => {});
    }, []);

    // The registry lives in localStorage, so the first paint can't know it.
    if (!mounted) return null;
    if (!active) return <FirstRun supported={supported} />;

    const snapshot = active.snapshot;
    const version = typeof snapshot?.system?.version === 'string' ? snapshot.system.version : null;
    const sessions = snapshot?.sessions?.total_sessions;
    const loggingOff = snapshot?.sessions?.logging_enabled === false;
    const wifi = snapshot?.wifi;
    const cloud = snapshot?.cloud;
    const updateAvailable = Boolean(
        latestVersion && version && compareVersions(latestVersion, version) > 0,
    );

    return (
        <>
            <PageHeader
                title={active.label}
                description={
                    connected ? 'Connected' : `Last read ${relativeLabel(snapshot?.fetchedAt)}`
                }
                actions={
                    updateAvailable && (
                        <Button nativeButton={false} render={<Link href="/grinder/update" />}>
                            <Zap />
                            Update to v{latestVersion}
                        </Button>
                    )
                }
            />
            <UnsupportedBrowser />

            <div className="max-w-3xl">
                <StatRow
                    label="Firmware"
                    href="/grinder/update"
                    value={<StatValue mono>{version ? `v${version}` : 'not read yet'}</StatValue>}
                    hint={
                        updateAvailable
                            ? `v${latestVersion} available`
                            : version
                              ? 'up to date'
                              : undefined
                    }
                    hintTone={updateAvailable ? 'caution' : 'muted'}
                />
                <StatRow
                    label="Network"
                    href="/grinder/wifi"
                    value={
                        <StatValue>
                            {!wifi?.configured
                                ? 'Not set up'
                                : !wifi.enabled
                                  ? 'Turned off'
                                  : (wifi.ssid ?? 'Configured')}
                        </StatValue>
                    }
                    hint={
                        wifi?.configured
                            ? wifi.time_synced
                                ? 'clock synced'
                                : 'clock not synced'
                            : undefined
                    }
                    hintTone={wifi?.configured && !wifi.time_synced ? 'caution' : 'muted'}
                />
                <StatRow
                    label="Backup"
                    href="/grinder/wifi"
                    value={
                        <StatValue>
                            {!cloud?.configured
                                ? 'Not set up'
                                : !cloud.enabled
                                  ? 'Turned off'
                                  : cloud.unsynced
                                    ? 'Pending'
                                    : 'On'}
                        </StatValue>
                    }
                    hint={cloud?.configured && cloud.unsynced ? 'waiting to upload' : undefined}
                    hintTone="caution"
                />
                <StatRow
                    label="Grinds on device"
                    href="/analytics"
                    value={
                        <StatValue mono>
                            {sessions === undefined ? '—' : String(sessions)}
                        </StatValue>
                    }
                    hint={loggingOff ? 'logging off — not recording' : undefined}
                    hintTone="caution"
                />
            </div>

            <p className="mt-8 text-muted-foreground text-sm">
                <Link
                    href="/analytics"
                    className="inline-flex items-center gap-1.5 underline-offset-4 hover:underline"
                >
                    Open analytics
                    <ArrowRight className="size-3.5" />
                </Link>
            </p>
        </>
    );
}
