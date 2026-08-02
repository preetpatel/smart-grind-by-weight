'use client';

// WiFi provisioning + cloud backup setup over BLE (React port of the
// flasher's WiFi tab and cloud-provision.js).
//
// Wire formats (src/config/bluetooth.h):
//   WiFi config:  [0x01][ssid]\0[pass]\0[tz_rule]\0[tz_name]\0 set, [0x02] forget
//   Cloud config: [0x01][url]\0[store_id]\0[upload_key]\0[view_key]\0 set, [0x02] forget
//   Status chars: JSON readback; the cloud one carries store_id + view_key so
//   any browser can claim dashboard access by holding the grinder. Secrets
//   (WiFi password, upload key) are never readable back.
import { Cloud, Wifi } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { StatRow, StatValue } from '@/components/stat-row';
import { type StatusMessage, StatusRegion } from '@/components/status-region';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authClient } from '@/lib/client/auth';
import type { CloudStatusJson, WifiStatusJson } from '@/lib/client/ble';
import * as ble from '@/lib/client/ble';
import {
    CloudApiError,
    claimStoreForDevice,
    deleteStore,
    getViewerSource,
    listMyStores,
    saveViewerSource,
} from '@/lib/client/cloud';
import { detectPosixTz, type PosixTz } from '@/lib/client/tz-posix';
import { useGrinder } from '@/lib/client/use-grinder';

function nulJoinedPayload(opcode: number, fields: string[]): Uint8Array {
    const enc = new TextEncoder();
    const encoded = fields.map((f) => enc.encode(f));
    const payload = new Uint8Array(1 + encoded.reduce((n, b) => n + b.length + 1, 0));
    payload[0] = opcode;
    let offset = 1;
    for (const bytes of encoded) {
        payload.set(bytes, offset);
        offset += bytes.length;
        payload[offset++] = 0;
    }
    return payload;
}

// Resting state and live progress are two different vocabularies. State is
// scanned as rows; progress is read as a short phrase while you wait. One
// function serving both is what turned this panel into a commentary track.
const sentence = (fragment: string) => `${fragment.charAt(0).toUpperCase()}${fragment.slice(1)}.`;

// Only the outcomes worth acting on — success and "not tried yet" are already
// legible in the rows.
const WIFI_FAILURE: Record<string, string> = {
    wifi_failed: 'couldn’t join — check the password',
    sntp_failed: 'joined, but no time server answered',
    aborted: 'the grinder was busy — it retries on its own',
};

const WIFI_PROGRESS: Record<string, string> = {
    connecting: 'Joining the network…',
    syncing: 'Syncing the clock…',
    uploading: 'Backing up grinds…',
};

const CLOUD_RESULT: Record<string, string> = {
    success: 'up to date',
    partial: 'partly uploaded',
    failed: 'server unreachable',
    aborted: 'interrupted — retries on its own',
};

const stamp = (epoch: number) => new Date(epoch * 1000).toLocaleString();

function WifiRows({ status }: { status: WifiStatusJson }) {
    if (!status.configured) return null;
    const synced = status.time_synced && status.last_sync_epoch > 0;
    return (
        <div className="mb-6">
            <StatRow
                label="Network"
                value={<StatValue mono>{status.ssid}</StatValue>}
                hint={status.enabled ? undefined : 'WiFi off'}
                hintTone="caution"
            />
            <StatRow
                label="Clock"
                value={
                    <StatValue>{synced ? stamp(status.last_sync_epoch) : 'not synced'}</StatValue>
                }
                hint={WIFI_FAILURE[status.last_result]}
                hintTone="caution"
            />
            {status.tz_name && (
                <StatRow label="Timezone" value={<StatValue mono>{status.tz_name}</StatValue>} />
            )}
        </div>
    );
}

function CloudRows({ status }: { status: CloudStatusJson }) {
    if (!status.configured) return null;
    const result = CLOUD_RESULT[status.last_result];
    return (
        <div className="mb-6">
            <StatRow
                label="Backup"
                value={
                    <StatValue>
                        {status.state === 'syncing'
                            ? 'uploading…'
                            : !status.enabled
                              ? 'off'
                              : (result ?? (status.unsynced ? 'waiting to upload' : 'nothing new'))}
                    </StatValue>
                }
                hintTone="caution"
            />
            {status.last_success_epoch > 0 && (
                <StatRow
                    label="Last upload"
                    value={<StatValue>{stamp(status.last_success_epoch)}</StatValue>}
                />
            )}
        </div>
    );
}

async function wifiChars() {
    await ble.connect();
    const service = await ble.getService(ble.UUIDS.SYSINFO_SERVICE);
    return {
        configChar: await service.getCharacteristic(ble.UUIDS.SYSINFO_WIFI_CONFIG),
        statusChar: await service.getCharacteristic(ble.UUIDS.SYSINFO_WIFI_STATUS),
    };
}

async function cloudChars() {
    await ble.connect();
    const service = await ble.getService(ble.UUIDS.SYSINFO_SERVICE);
    return {
        configChar: await service.getCharacteristic(ble.UUIDS.SYSINFO_CLOUD_CONFIG),
        statusChar: await service.getCharacteristic(ble.UUIDS.SYSINFO_CLOUD_STATUS),
    };
}

async function readJsonChar<T>(characteristic: BluetoothRemoteGATTCharacteristic): Promise<T> {
    const value = await characteristic.readValue();
    return JSON.parse(new TextDecoder().decode(value)) as T;
}

// The device must be able to reach the sync server from its own network, so
// localhost is meaningless to it.
function apiBaseForDevice(): string {
    const base = window.SGBW_API_BASE || location.origin;
    if (/^https?:\/\/(localhost|127\.)/.test(base) && !window.SGBW_API_BASE) {
        throw new Error(
            'This page is served from localhost, which the grinder cannot reach. ' +
                "Set window.SGBW_API_BASE to your server's LAN address first.",
        );
    }
    return base;
}

export function WifiSyncPanel() {
    const { active } = useGrinder();
    const { data: session } = authClient.useSession();
    const [ssid, setSsid] = useState('');
    const [password, setPassword] = useState('');
    const [tz, setTz] = useState<PosixTz | null>(null);
    const [tzError, setTzError] = useState(false);
    const [wifiStatus, setWifiStatus] = useState<StatusMessage | null>(null);
    const [cloudStatus, setCloudStatus] = useState<StatusMessage | null>(null);
    const [wifiBusy, setWifiBusy] = useState(false);
    const [cloudBusy, setCloudBusy] = useState(false);
    const [confirmForgetWifi, setConfirmForgetWifi] = useState(false);
    const [confirmForgetCloud, setConfirmForgetCloud] = useState(false);
    const [storeToDelete, setStoreToDelete] = useState<string | null>(null);

    const deleteCloudStore = async (storeId: string) => {
        try {
            await deleteStore(storeId);
            setCloudStatus({ text: 'Backup deleted.', kind: 'success' });
        } catch (error) {
            setCloudStatus({
                text: `Couldn’t delete it: ${error instanceof Error ? error.message : error}`,
                kind: 'error',
            });
        }
    };

    useEffect(() => {
        try {
            setTz(detectPosixTz());
        } catch (error) {
            console.error('Timezone detection failed:', error);
            setTzError(true);
            setTz({ rule: '', zoneName: '' });
        }
    }, []);

    // Prefill the SSID from the cached snapshot, as the original did.
    const knownWifi = active?.snapshot?.wifi;
    useEffect(() => {
        if (knownWifi?.ssid) {
            setSsid((current) => current || knownWifi.ssid);
        }
    }, [knownWifi?.ssid]);

    const knownCloud = active?.snapshot?.cloud;
    // Unknown is not the same as absent: a browser that has never read this
    // grinder must not be told it needs WiFi it may well already have.
    const signedIn = Boolean(session?.user);
    const needsWifi = knownWifi !== undefined && !knownWifi.configured;

    const configureWifi = async () => {
        if (!ssid.trim()) {
            setWifiStatus({ text: 'Enter a network name.', kind: 'error' });
            return;
        }
        setWifiBusy(true);
        let statusChar: BluetoothRemoteGATTCharacteristic | null = null;
        let onStatusFrame: ((event: Event) => void) | null = null;
        // Object holder rather than a plain let: assignments happen inside the
        // notification callback, invisible to TS control-flow narrowing.
        const lastStatus: { current: WifiStatusJson | null } = { current: null };
        try {
            setWifiStatus({ text: 'Connecting…', kind: 'info' });
            const chars = await wifiChars();
            statusChar = chars.statusChar;

            // Live progress while the grinder tries the network
            onStatusFrame = (event) => {
                const target = event.target as BluetoothRemoteGATTCharacteristic;
                if (!target.value) return;
                try {
                    lastStatus.current = JSON.parse(
                        new TextDecoder().decode(target.value),
                    ) as WifiStatusJson;
                    const phrase = WIFI_PROGRESS[lastStatus.current.state];
                    if (phrase) setWifiStatus({ text: phrase, kind: 'info' });
                } catch {
                    /* partial/invalid frame; wait for the next one */
                }
            };
            await statusChar.startNotifications();
            statusChar.addEventListener('characteristicvaluechanged', onStatusFrame);

            const zone = tz ?? { rule: '', zoneName: '' };
            await chars.configChar.writeValue(
                nulJoinedPayload(0x01, [
                    ssid.trim(),
                    password,
                    zone.rule,
                    zone.zoneName,
                ]) as BufferSource,
            );
            setWifiStatus({ text: 'Joining the network…', kind: 'info' });

            // The grinder attempts the connection immediately; wait for a
            // terminal result (sync done or failed), up to ~60s.
            const deadline = Date.now() + 60000;
            let outcome: WifiStatusJson | null = null;
            while (Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 500));
                const s = lastStatus.current;
                if (s?.configured && s.state === 'idle' && s.last_result !== 'none') {
                    outcome = s;
                    break;
                }
            }

            if (outcome?.last_result === 'success') {
                setWifiStatus({ text: 'Clock synced.', kind: 'success' });
            } else if (outcome) {
                setWifiStatus({
                    text: sentence(WIFI_FAILURE[outcome.last_result] ?? 'the first sync failed'),
                    kind: 'error',
                });
            } else {
                setWifiStatus({
                    text: 'Saved. No result yet — Refresh in a minute.',
                    kind: 'info',
                });
            }
            const freshest = outcome ?? lastStatus.current;
            if (freshest) ble.applyPatch({ wifi: freshest });
        } catch (error) {
            console.error('WiFi setup error:', error);
            setWifiStatus({
                text: `WiFi setup failed: ${error instanceof Error ? error.message : error}`,
                kind: 'error',
            });
        } finally {
            if (statusChar) {
                if (onStatusFrame) {
                    statusChar.removeEventListener('characteristicvaluechanged', onStatusFrame);
                }
                try {
                    await statusChar.stopNotifications();
                } catch {
                    /* best-effort */
                }
            }
            ble.release();
            setWifiBusy(false);
        }
    };

    const checkWifi = async () => {
        try {
            setWifiStatus({ text: 'Connecting…', kind: 'info' });
            const { statusChar } = await wifiChars();
            const status = await readJsonChar<WifiStatusJson>(statusChar);
            // The rows above carry the detail; this only says the read landed.
            setWifiStatus(null);
            ble.applyPatch({ wifi: status });
        } catch (error) {
            setWifiStatus({
                text: `Couldn’t read the grinder: ${error instanceof Error ? error.message : error}`,
                kind: 'error',
            });
        } finally {
            ble.release();
        }
    };

    const forgetWifi = async () => {
        try {
            setWifiStatus({ text: 'Connecting…', kind: 'info' });
            const { configChar } = await wifiChars();
            await configChar.writeValue(new Uint8Array([0x02]) as BufferSource);
            setWifiStatus({ text: 'Network forgotten.', kind: 'success' });
            ble.applyPatch({ wifi: { configured: false } as WifiStatusJson });
        } catch (error) {
            setWifiStatus({
                text: `Couldn’t forget it: ${error instanceof Error ? error.message : error}`,
                kind: 'error',
            });
        } finally {
            ble.release();
        }
    };

    const setUpCloudBackup = async () => {
        if (!signedIn) return;
        setCloudBusy(true);
        // The server round trip sits between two BLE operations; hold the link
        // so the idle timer can't drop it mid-flow.
        ble.hold();
        try {
            const serverUrl = apiBaseForDevice();

            setCloudStatus({ text: 'Connecting…', kind: 'info' });
            // Read the grinder rather than the cached snapshot: this browser
            // may never have seen it, and trusting the cache is exactly how a
            // second store used to appear for a grinder that already had one.
            const snapshot = await ble.refreshSnapshot({ interactive: true });
            const deviceId = snapshot.system?.device_id;
            if (typeof deviceId !== 'string' || !deviceId) {
                setCloudStatus({
                    text: 'This firmware is too old to back up — update it first.',
                    kind: 'error',
                });
                return;
            }

            // The store is chosen by grinder, not by browser: same device,
            // same store, however many times this runs. Its own keys are the
            // proof of possession that allows taking over a second-hand one.
            setCloudStatus({ text: 'Preparing…', kind: 'info' });
            const onDevice = snapshot.cloud;
            const credentials = await claimStoreForDevice({
                deviceId,
                name: active?.label ?? null,
                proof:
                    onDevice?.configured && onDevice.view_key
                        ? { store_id: onDevice.store_id, view_key: onDevice.view_key }
                        : undefined,
            });

            const { configChar, statusChar } = await cloudChars();
            await configChar.writeValue(
                nulJoinedPayload(0x01, [
                    serverUrl,
                    credentials.store_id,
                    credentials.upload_key,
                    credentials.view_key,
                ]) as BufferSource,
            );

            // The write is applied on the grinder's bluetooth task; give it a
            // beat, then read back the (secret-free) status to confirm.
            await new Promise((resolve) => setTimeout(resolve, 600));
            const status = await readJsonChar<CloudStatusJson>(statusChar);
            ble.applyPatch({ cloud: status });
            if (status.configured) {
                setCloudStatus({ text: 'Backup on.', kind: 'success' });
            } else {
                setCloudStatus({ text: 'The grinder refused it — try again.', kind: 'error' });
            }
        } catch (error) {
            console.error('Cloud setup error:', error);
            setCloudStatus({
                text:
                    error instanceof CloudApiError && error.code === 'device_bound_elsewhere'
                        ? 'This grinder belongs to another account — its owner has to release it first.'
                        : `Setup failed: ${error instanceof Error ? error.message : error}`,
                kind: 'error',
            });
        } finally {
            ble.releaseHold();
            setCloudBusy(false);
        }
    };

    const checkCloud = async () => {
        try {
            setCloudStatus({ text: 'Connecting…', kind: 'info' });
            const { statusChar } = await cloudChars();
            const status = await readJsonChar<CloudStatusJson>(statusChar);
            ble.applyPatch({ cloud: status });

            // Claim by possession, read-only: any browser reading a
            // provisioned grinder gets the view keys and can open the
            // dashboard. Owners get full access by signing in instead.
            if (status.configured && status.view_key && !getViewerSource()) {
                saveViewerSource({
                    storeId: status.store_id,
                    viewKey: status.view_key,
                    baseUrl: status.server_url || '',
                    linkedAt: Date.now(),
                });
                setCloudStatus({ text: 'This browser is linked, read-only.', kind: 'success' });
                return;
            }
            // The rows above carry the detail; this only says the read landed.
            setCloudStatus(null);
        } catch (error) {
            setCloudStatus({
                text: `Couldn’t read the grinder: ${error instanceof Error ? error.message : error}`,
                kind: 'error',
            });
        } finally {
            ble.release();
        }
    };

    const forgetCloud = async () => {
        // Capture the store id from the cached snapshot before the forget
        // wipes it — needed for the optional owner-side deletion below.
        const deviceStoreId = active?.snapshot?.cloud?.configured
            ? active.snapshot.cloud.store_id
            : null;
        try {
            setCloudStatus({ text: 'Connecting…', kind: 'info' });
            const { configChar } = await cloudChars();
            await configChar.writeValue(new Uint8Array([0x02]) as BufferSource);
            ble.applyPatch({ cloud: { configured: false } as CloudStatusJson });

            // Offer server-side deletion only when the signed-in account owns
            // the store the grinder was uploading to.
            const ownsIt =
                session?.user && deviceStoreId
                    ? (await listMyStores().catch(() => [])).some(
                          (store) => store.store_id === deviceStoreId,
                      )
                    : false;
            // The store keeps its grinder, so turning backup on again lands back
            // on this history rather than starting a second store. Handing the
            // grinder on is Release, over on the account page.
            setCloudStatus({ text: 'Backup off.', kind: 'success' });
            // Owning the store is the only case where deleting it is ours to
            // offer, so ask separately rather than bundling it into one prompt.
            if (ownsIt && deviceStoreId) setStoreToDelete(deviceStoreId);
        } catch (error) {
            setCloudStatus({
                text: `Couldn’t turn it off: ${error instanceof Error ? error.message : error}`,
                kind: 'error',
            });
        } finally {
            ble.release();
        }
    };

    return (
        <div className="max-w-2xl">
            <section>
                <h2 className="mb-4 font-medium text-base">WiFi</h2>

                {knownWifi && <WifiRows status={knownWifi} />}

                <div className="space-y-4">
                    <div className="space-y-2">
                        <Label htmlFor="wifiSsid">Network name</Label>
                        {/* These are the grinder's WiFi credentials, not a login
                            for this site — tell password managers to keep out so
                            they don't offer to save the PSK as an account
                            password. */}
                        <Input
                            id="wifiSsid"
                            name="wifiSsid"
                            type="text"
                            maxLength={32}
                            autoComplete="off"
                            data-1p-ignore
                            data-lpignore="true"
                            placeholder="MyHomeWiFi"
                            className="max-w-sm font-mono"
                            value={ssid}
                            onChange={(e) => setSsid(e.target.value)}
                        />
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="wifiPassword">Password</Label>
                        <Input
                            id="wifiPassword"
                            name="wifiPassword"
                            type="password"
                            maxLength={64}
                            autoComplete="off"
                            data-1p-ignore
                            data-lpignore="true"
                            className="max-w-sm font-mono"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                        />
                    </div>

                    <p className="text-xs">
                        <span className="text-muted-foreground">Timezone </span>
                        {tzError ? (
                            <span className="text-caution">
                                not detected — the clock runs in UTC
                            </span>
                        ) : tz ? (
                            <span className="font-mono text-muted-foreground">
                                {tz.zoneName} · {tz.rule}
                            </span>
                        ) : (
                            <span className="text-muted-foreground">detecting…</span>
                        )}
                    </p>
                </div>

                <div className="mt-5 flex flex-wrap gap-2">
                    <Button disabled={wifiBusy} onClick={configureWifi}>
                        <Wifi />
                        {wifiBusy ? 'Saving…' : 'Save'}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={checkWifi}>
                        Refresh
                    </Button>
                    <Button
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => setConfirmForgetWifi(true)}
                    >
                        Forget network
                    </Button>
                </div>

                <div className="mt-5">
                    <StatusRegion status={wifiStatus} />
                </div>
            </section>

            <section className="mt-10 border-t pt-8">
                <h2 className="mb-4 font-medium text-base">Backup</h2>

                {knownCloud && <CloudRows status={knownCloud} />}

                <div className="flex flex-wrap items-center gap-2">
                    <Button
                        disabled={cloudBusy || !signedIn || needsWifi}
                        onClick={setUpCloudBackup}
                    >
                        <Cloud />
                        {cloudBusy ? 'Setting up…' : 'Turn on backup'}
                    </Button>
                    {/* The control carries its own readiness rather than a
                        paragraph above it listing what backup requires. */}
                    {!signedIn ? (
                        <Link
                            href="/signin"
                            className="text-muted-foreground text-sm underline-offset-4 hover:text-foreground hover:underline"
                        >
                            Sign in first
                        </Link>
                    ) : (
                        needsWifi && (
                            <span className="text-muted-foreground text-sm">Needs WiFi</span>
                        )
                    )}
                    <Button variant="ghost" size="sm" onClick={checkCloud}>
                        Refresh
                    </Button>
                    <Button
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => setConfirmForgetCloud(true)}
                    >
                        Turn off
                    </Button>
                </div>

                <div className="mt-5">
                    <StatusRegion status={cloudStatus} />
                </div>
            </section>

            <ConfirmDialog
                open={confirmForgetWifi}
                onOpenChange={setConfirmForgetWifi}
                title="Forget this network?"
                description="The grinder stops syncing its clock."
                confirmLabel="Forget network"
                destructive
                onConfirm={() => forgetWifi()}
            />

            <ConfirmDialog
                open={confirmForgetCloud}
                onOpenChange={setConfirmForgetCloud}
                title="Turn off backup?"
                description="The grinder stops uploading. Grinds already backed up are kept."
                confirmLabel="Turn off"
                destructive
                onConfirm={() => forgetCloud()}
            />

            <ConfirmDialog
                open={storeToDelete !== null}
                onOpenChange={(open) => !open && setStoreToDelete(null)}
                title="Also delete the backup?"
                description="Permanently deletes every grind in it. This cannot be undone."
                confirmLabel="Delete backup"
                cancelLabel="Keep it"
                destructive
                onConfirm={() => {
                    if (storeToDelete) deleteCloudStore(storeToDelete);
                    setStoreToDelete(null);
                }}
            />
        </div>
    );
}
