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
import { useEffect, useMemo, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
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

function describeWifiStatus(status: WifiStatusJson): string {
    if (!status.configured) return 'No WiFi credentials stored on the grinder.';
    const parts = [`Network: ${status.ssid}`];
    if (!status.enabled) {
        parts.push('WiFi is turned off on the grinder.');
    } else {
        const idleText =
            status.last_result === 'success'
                ? 'Synced — radio off until the next daily sync'
                : status.last_result === 'wifi_failed'
                  ? 'Could not join the network (check the password)'
                  : status.last_result === 'sntp_failed'
                    ? 'Joined the network but got no time-server response'
                    : status.last_result === 'aborted'
                      ? 'Deferred (grinder was busy), will retry shortly'
                      : 'Waiting for the first sync attempt';
        const stateText =
            {
                idle: idleText,
                connecting: 'Connecting to the network…',
                syncing: 'Connected — syncing the clock…',
                uploading: 'Connected — backing up grind sessions…',
                disabled: 'WiFi is turned off on the grinder.',
                not_configured: 'No credentials stored.',
            }[status.state] ?? status.state;
        parts.push(stateText);
    }
    if (status.tz_name) parts.push(`Timezone: ${status.tz_name}`);
    if (status.time_synced && status.last_sync_epoch) {
        parts.push(
            `Clock last synced: ${new Date(status.last_sync_epoch * 1000).toLocaleString()}`,
        );
    }
    return parts.join(' · ');
}

function describeCloudStatus(status: CloudStatusJson): string {
    if (!status.configured) return 'No cloud store on the grinder yet.';
    const parts = [
        `Store ${status.store_id}${status.enabled ? '' : ' (sync turned off on the grinder)'}`,
    ];
    const idleText =
        {
            success: 'Up to date',
            partial: 'Partially synced — the next WiFi window continues',
            failed: 'Server unreachable on the last attempt',
            aborted: 'Last attempt was interrupted (grinder was busy)',
            none: status.unsynced ? 'Waiting for the next WiFi window' : 'Nothing to sync yet',
        }[status.last_result] ?? status.last_result;
    parts.push(status.state === 'syncing' ? 'Uploading sessions now…' : idleText);
    if (status.last_success_epoch) {
        parts.push(`last synced ${new Date(status.last_success_epoch * 1000).toLocaleString()}`);
    }
    return parts.join(' · ');
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
            setCloudStatus({
                text: 'Cloud store deleted, along with every session in it.',
                kind: 'success',
            });
        } catch (error) {
            setCloudStatus({
                text: `Could not delete the store: ${error instanceof Error ? error.message : error}`,
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

    const knownWifiText = useMemo(
        () => (knownWifi ? describeWifiStatus(knownWifi) : null),
        [knownWifi],
    );

    const configureWifi = async () => {
        if (!ssid.trim()) {
            setWifiStatus({ text: 'Enter the WiFi network name first.', kind: 'error' });
            return;
        }
        setWifiBusy(true);
        let statusChar: BluetoothRemoteGATTCharacteristic | null = null;
        let onStatusFrame: ((event: Event) => void) | null = null;
        // Object holder rather than a plain let: assignments happen inside the
        // notification callback, invisible to TS control-flow narrowing.
        const lastStatus: { current: WifiStatusJson | null } = { current: null };
        try {
            setWifiStatus({ text: 'Connecting to grinder…', kind: 'info' });
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
                    setWifiStatus({ text: describeWifiStatus(lastStatus.current), kind: 'info' });
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
            setWifiStatus({
                text: 'Credentials sent — grinder is trying the network…',
                kind: 'info',
            });

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
                setWifiStatus({
                    text: `✓ WiFi set up and clock synced! ${describeWifiStatus(outcome)}`,
                    kind: 'success',
                });
            } else if (outcome) {
                setWifiStatus({
                    text: `WiFi saved, but the first sync failed. ${describeWifiStatus(outcome)} The grinder keeps retrying on its own.`,
                    kind: 'error',
                });
            } else {
                setWifiStatus({
                    text: 'Credentials saved. No result yet — use Check Status in a minute.',
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
            setWifiStatus({ text: 'Connecting to grinder…', kind: 'info' });
            const { statusChar } = await wifiChars();
            const status = await readJsonChar<WifiStatusJson>(statusChar);
            setWifiStatus({
                text: describeWifiStatus(status),
                kind: status.time_synced ? 'success' : 'info',
            });
            ble.applyPatch({ wifi: status });
        } catch (error) {
            setWifiStatus({
                text: `Could not read WiFi status: ${error instanceof Error ? error.message : error}`,
                kind: 'error',
            });
        } finally {
            ble.release();
        }
    };

    const forgetWifi = async () => {
        try {
            setWifiStatus({ text: 'Connecting to grinder…', kind: 'info' });
            const { configChar } = await wifiChars();
            await configChar.writeValue(new Uint8Array([0x02]) as BufferSource);
            setWifiStatus({
                text: 'WiFi credentials removed from the grinder.',
                kind: 'success',
            });
            ble.applyPatch({ wifi: { configured: false } as WifiStatusJson });
        } catch (error) {
            setWifiStatus({
                text: `Could not forget WiFi: ${error instanceof Error ? error.message : error}`,
                kind: 'error',
            });
        } finally {
            ble.release();
        }
    };

    const setUpCloudBackup = async () => {
        if (!session?.user) {
            setCloudStatus({
                text: 'Sign in first — backups belong to your account.',
                kind: 'error',
            });
            return;
        }
        setCloudBusy(true);
        // The server round trip sits between two BLE operations; hold the link
        // so the idle timer can't drop it mid-flow.
        ble.hold();
        try {
            const serverUrl = apiBaseForDevice();

            setCloudStatus({ text: 'Connecting to grinder…', kind: 'info' });
            // Read the grinder rather than the cached snapshot: this browser
            // may never have seen it, and trusting the cache is exactly how a
            // second store used to appear for a grinder that already had one.
            const snapshot = await ble.refreshSnapshot({ interactive: true });
            const deviceId = snapshot.system?.device_id;
            if (typeof deviceId !== 'string' || !deviceId) {
                setCloudStatus({
                    text: 'Could not read this grinder’s id — update its firmware and try again.',
                    kind: 'error',
                });
                return;
            }

            // The store is chosen by grinder, not by browser: same device,
            // same store, however many times this runs. Its own keys are the
            // proof of possession that allows taking over a second-hand one.
            setCloudStatus({ text: 'Preparing your cloud store…', kind: 'info' });
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
                setCloudStatus({
                    text: `Backing up. ${describeCloudStatus(status)}`,
                    kind: 'success',
                });
            } else {
                setCloudStatus({
                    text: 'The grinder did not accept the configuration — try again.',
                    kind: 'error',
                });
            }
        } catch (error) {
            console.error('Cloud setup error:', error);
            setCloudStatus({
                text:
                    error instanceof CloudApiError && error.code === 'device_bound_elsewhere'
                        ? 'This grinder is registered to another account. Its owner can release it from their account page.'
                        : `Cloud setup failed: ${error instanceof Error ? error.message : error}`,
                kind: 'error',
            });
        } finally {
            ble.releaseHold();
            setCloudBusy(false);
        }
    };

    const checkCloud = async () => {
        try {
            setCloudStatus({ text: 'Connecting to grinder…', kind: 'info' });
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
                setCloudStatus({
                    text: `${describeCloudStatus(status)} · This browser is linked, read-only.`,
                    kind: 'success',
                });
                return;
            }
            setCloudStatus({
                text: describeCloudStatus(status),
                kind: status.last_result === 'success' ? 'success' : 'info',
            });
        } catch (error) {
            setCloudStatus({
                text: `Could not read cloud sync status: ${error instanceof Error ? error.message : error}`,
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
            setCloudStatus({ text: 'Connecting to grinder…', kind: 'info' });
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
            // The store keeps its grinder, so setting sync up again lands back
            // on this history rather than starting a second store. Handing the
            // grinder on is Release, over on the account page.
            setCloudStatus({
                text: 'Sync removed. Uploaded grinds stay in your account.',
                kind: 'success',
            });
            // Owning the store is the only case where deleting it is ours to
            // offer, so ask separately rather than bundling it into one prompt.
            if (ownsIt && deviceStoreId) setStoreToDelete(deviceStoreId);
        } catch (error) {
            setCloudStatus({
                text: `Could not forget cloud sync: ${error instanceof Error ? error.message : error}`,
                kind: 'error',
            });
        } finally {
            ble.release();
        }
    };

    return (
        <div className="max-w-2xl">
            <section>
                <h2 className="font-medium text-base">WiFi</h2>
                <p className="mt-1 mb-5 text-muted-foreground text-sm">
                    A few seconds a day to set the clock, then the radio goes off. Daylight saving
                    is read from this browser and runs on the grinder itself.
                </p>

                {knownWifiText && (
                    <p
                        className={
                            knownWifi?.time_synced
                                ? 'mb-5 text-success text-sm'
                                : 'mb-5 text-muted-foreground text-sm'
                        }
                    >
                        {knownWifiText}
                    </p>
                )}

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
                                could not be detected — the clock will run in UTC
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
                        {wifiBusy ? 'Sending…' : 'Send to grinder'}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={checkWifi}>
                        Check status
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
                <h2 className="font-medium text-base">Cloud backup</h2>
                <p className="mt-1 mb-5 text-muted-foreground text-sm">
                    The grinder holds its last hundred or so grinds. Your account holds all of them,
                    on every browser you sign in to.
                </p>

                <div className="flex flex-wrap gap-2">
                    <Button disabled={cloudBusy} onClick={setUpCloudBackup}>
                        <Cloud />
                        {cloudBusy ? 'Setting up…' : 'Set up cloud backup'}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={checkCloud}>
                        Check status
                    </Button>
                    <Button
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => setConfirmForgetCloud(true)}
                    >
                        Forget sync
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
                description="The grinder drops the credentials and stops syncing its clock. You can set it up again any time."
                confirmLabel="Forget network"
                destructive
                onConfirm={() => forgetWifi()}
            />

            <ConfirmDialog
                open={confirmForgetCloud}
                onOpenChange={setConfirmForgetCloud}
                title="Stop backing up?"
                description="The grinder stops uploading. Everything already backed up stays in your account, and setting sync up again returns to the same history."
                confirmLabel="Forget sync"
                destructive
                onConfirm={() => forgetCloud()}
            />

            <ConfirmDialog
                open={storeToDelete !== null}
                onOpenChange={(open) => !open && setStoreToDelete(null)}
                title="Also delete the backup?"
                description="Permanently removes every grind it holds, for every browser and share link. This cannot be undone."
                confirmLabel="Delete store"
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
