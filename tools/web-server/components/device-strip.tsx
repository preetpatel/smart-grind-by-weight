'use client';

// Device strip: a one-line grinder status row in the header chrome, above
// the tabs — mirroring how the firmware itself keeps device status in the
// screen corner rather than in the content area. (React port of the
// flasher's grinder-card.js.)
//
// No known grinder → a pairing prompt with a single Connect action.
// Known grinder → dot + name + terse facts from the cached snapshot
// (firmware version, sessions on device, WiFi + backup state), refreshed
// silently in the background when the browser supports persistent BLE
// permissions.
import { useEffect, useRef, useState } from 'react';
import type { CloudStatusJson, WifiStatusJson } from '@/lib/client/ble';
import * as ble from '@/lib/client/ble';
import { compareVersions, fetchReleases, latestStable } from '@/lib/client/releases';
import { useGrinder } from '@/lib/client/use-grinder';

function agoLabel(ts: number | undefined): string | null {
    if (!ts) return null;
    const minutes = Math.floor((Date.now() - ts) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

function wifiShortLabel(wifi: WifiStatusJson | undefined): string | null {
    if (!wifi) return null;
    if (!wifi.configured) return 'WiFi not set up';
    if (!wifi.enabled) return 'WiFi off';
    if (wifi.time_synced) return 'WiFi synced';
    return 'WiFi configured';
}

function cloudShortLabel(cloud: CloudStatusJson | undefined): string | null {
    if (!cloud?.configured) return null;
    if (!cloud.enabled) return 'backup off';
    if (cloud.state === 'syncing') return 'backing up…';
    if (cloud.unsynced) return 'backup pending';
    if (cloud.last_result === 'success') return 'backed up ✓';
    return 'backup on';
}

export function DeviceStrip() {
    const { supported, connected, active, grinders } = useGrinder();
    const [busy, setBusy] = useState(false);
    const [latestVersion, setLatestVersion] = useState<string | null>(null);
    const refreshed = useRef(false);

    useEffect(() => {
        fetchReleases()
            .then((entries) => setLatestVersion(latestStable(entries)?.version ?? null))
            .catch(() => {});
    }, []);

    // Background refresh of the active grinder — silent (no chooser), quiet
    // on failure (grinder off / browser without getDevices).
    useEffect(() => {
        if (!refreshed.current && supported && active) {
            refreshed.current = true;
            ble.refreshSnapshot({ interactive: false }).catch(() => {});
        }
    }, [supported, active]);

    if (!supported) return null;

    const runBusy = async (fn: () => Promise<unknown>, errorPrefix: string) => {
        if (busy) return;
        setBusy(true);
        try {
            await fn();
        } catch (error) {
            // Chooser dismissed is not an error.
            if ((error as Error).name !== 'NotFoundError') {
                console.error(`${errorPrefix}:`, error);
                alert(`${errorPrefix}: ${(error as Error).message}`);
            }
        } finally {
            setBusy(false);
        }
    };

    if (!active) {
        return (
            <div className="device-strip">
                <span className="conn-dot none" />
                <span className="g-name dim">No grinder paired</span>
                <span className="g-hint">
                    pair once to see its firmware, WiFi and grind data here
                </span>
                <button
                    type="button"
                    className="btn btn-accent btn-compact"
                    disabled={busy}
                    onClick={() => runBusy(() => ble.addGrinder(), 'Could not connect')}
                >
                    Connect grinder
                </button>
            </div>
        );
    }

    const snapshot = active.snapshot;
    const version = typeof snapshot?.system?.version === 'string' ? snapshot.system.version : null;
    const totalSessions = snapshot?.sessions?.total_sessions;
    const wifiLabel = wifiShortLabel(snapshot?.wifi);
    const cloudLabel = cloudShortLabel(snapshot?.cloud);
    const updateAvailable =
        latestVersion && version && compareVersions(latestVersion, version) > 0
            ? latestVersion
            : null;

    return (
        <div className="device-strip">
            <span className={`conn-dot ${connected ? 'connected' : ''}`} />
            <span className="g-name">{active.label}</span>
            <div className="g-facts">
                {version && <span>v{version}</span>}
                {totalSessions !== undefined && <span>{String(totalSessions)} sessions</span>}
                {wifiLabel && <span>{wifiLabel}</span>}
                {cloudLabel && <span>{cloudLabel}</span>}
                <span>
                    {snapshot ? `checked ${agoLabel(snapshot.fetchedAt)}` : 'not checked yet'}
                </span>
            </div>
            {updateAvailable && (
                <span className="g-chip update">Update available: v{updateAvailable}</span>
            )}
            {snapshot?.sessions?.logging_enabled === false && (
                <span className="g-chip warn">Grind logging off</span>
            )}
            <div className="g-actions">
                {grinders.length > 1 && (
                    <select value={active.id} onChange={(e) => ble.setActive(e.target.value)}>
                        {grinders.map((grinder) => (
                            <option key={grinder.id} value={grinder.id}>
                                {grinder.label}
                            </option>
                        ))}
                    </select>
                )}
                <button
                    type="button"
                    className="btn-ghost"
                    disabled={busy}
                    onClick={() =>
                        runBusy(() => ble.refreshSnapshot({ interactive: true }), 'Refresh failed')
                    }
                >
                    Refresh
                </button>
                <button
                    type="button"
                    className="btn-ghost"
                    disabled={busy}
                    onClick={() => runBusy(() => ble.addGrinder(), 'Could not add grinder')}
                >
                    + Add
                </button>
                <button
                    type="button"
                    className="btn-ghost danger"
                    disabled={busy}
                    onClick={() => {
                        if (
                            window.confirm(
                                `Forget ${active.label} in this browser? The grinder itself is not changed.`,
                            )
                        ) {
                            ble.forget(active.id);
                        }
                    }}
                >
                    Forget
                </button>
            </div>
        </div>
    );
}
