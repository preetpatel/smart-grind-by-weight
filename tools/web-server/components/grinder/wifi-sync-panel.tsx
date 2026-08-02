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
import { useEffect, useMemo, useState } from 'react';
import { StatusBox, type StatusMessage } from '@/components/ui';
import { authClient } from '@/lib/client/auth';
import type { CloudStatusJson, WifiStatusJson } from '@/lib/client/ble';
import * as ble from '@/lib/client/ble';
import {
    createCloudStore,
    deleteStore,
    getViewerSource,
    listMyStores,
    provisionStore,
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
        if (!confirm('Remove the stored WiFi credentials from the grinder?')) return;
        try {
            setWifiStatus({ text: 'Connecting to grinder…', kind: 'info' });
            const { configChar } = await wifiChars();
            await configChar.writeValue(new Uint8Array([0x02]) as BufferSource);
            setWifiStatus({
                text: '✓ WiFi credentials removed from the grinder.',
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
        setCloudBusy(true);
        try {
            if (!session?.user) {
                setCloudStatus({
                    text: 'Sign in first (top right) — cloud backups belong to your account, so your dashboards follow you to any browser.',
                    kind: 'error',
                });
                return;
            }
            const serverUrl = apiBaseForDevice();

            // If the grinder already carries one of this account's stores,
            // re-provision it (rotate-on-provision mints a fresh upload key);
            // otherwise create a new store named after the grinder.
            setCloudStatus({ text: 'Preparing your cloud store…', kind: 'info' });
            const mine = await listMyStores();
            const deviceCloud = active?.snapshot?.cloud;
            const existing = deviceCloud?.configured
                ? mine.find((store) => store.store_id === deviceCloud.store_id)
                : undefined;
            const credentials = existing
                ? await provisionStore(existing.store_id)
                : await createCloudStore(active?.label ?? null);

            setCloudStatus({ text: 'Connecting to grinder…', kind: 'info' });
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
                    text: `✓ Cloud backup is on. Sessions upload after every grind over WiFi — ${describeCloudStatus(status)}`,
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
                text: `Cloud setup failed: ${error instanceof Error ? error.message : error}`,
                kind: 'error',
            });
        } finally {
            ble.release();
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
                    text: `${describeCloudStatus(status)} · This browser is now linked (view-only) — open Analytics to see the dashboard.`,
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
        if (
            !confirm(
                'Remove the cloud store keys from the grinder? Sessions already uploaded stay on the server.',
            )
        ) {
            return;
        }
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
            if (
                ownsIt &&
                deviceStoreId &&
                confirm('Also permanently delete the cloud store and every session in it?')
            ) {
                await deleteStore(deviceStoreId);
                setCloudStatus({
                    text: '✓ Sync removed from the grinder and the cloud store deleted.',
                    kind: 'success',
                });
            } else {
                setCloudStatus({
                    text: '✓ Sync removed from the grinder. The cloud store itself remains (manage it from your Account page).',
                    kind: 'success',
                });
            }
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
        <div className="form-stack">
            <h2>WiFi time sync</h2>
            <p className="lede-line">
                Your WiFi keeps the grinder&apos;s clock synced — a few seconds a day, radio off
                otherwise — and powers the optional cloud backup below. Daylight-saving rules come
                from this browser and run on the grinder itself.
            </p>

            {knownWifiText && (
                <div className={`status ${knownWifi?.time_synced ? 'success' : 'info'}`}>
                    {knownWifiText}
                </div>
            )}

            <div className="form-group">
                <label htmlFor="wifiSsid">Network name (SSID)</label>
                {/* These are the grinder's WiFi credentials, not a login for
                    this site — tell password managers to keep out so they
                    don't offer to save the PSK as an account password. */}
                <input
                    id="wifiSsid"
                    name="wifiSsid"
                    type="text"
                    maxLength={32}
                    autoComplete="off"
                    data-1p-ignore
                    data-lpignore="true"
                    placeholder="MyHomeWiFi"
                    value={ssid}
                    onChange={(e) => setSsid(e.target.value)}
                />
            </div>

            <div className="form-group">
                <label htmlFor="wifiPassword">Password</label>
                <input
                    id="wifiPassword"
                    name="wifiPassword"
                    type="password"
                    maxLength={64}
                    autoComplete="off"
                    data-1p-ignore
                    data-lpignore="true"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                />
            </div>

            <div className="form-group">
                <span className="check-line" style={{ marginBottom: 6, fontWeight: 600 }}>
                    Timezone (from this browser)
                </span>
                <div className={`status ${tzError ? 'error' : 'info'}`}>
                    {tzError
                        ? 'Timezone detection failed — clock will sync in UTC'
                        : tz
                          ? `${tz.zoneName} — rule ${tz.rule}`
                          : 'Detecting…'}
                </div>
            </div>

            <div className="btn-row">
                <button
                    type="button"
                    className="btn btn-accent"
                    disabled={wifiBusy}
                    onClick={configureWifi}
                >
                    Connect &amp; Send to Grinder
                </button>
                <button type="button" className="btn-ghost" onClick={checkWifi}>
                    Check Status
                </button>
                <button type="button" className="btn-ghost danger" onClick={forgetWifi}>
                    Forget WiFi
                </button>
            </div>

            <StatusBox status={wifiStatus} />

            <h2 style={{ marginTop: 36 }}>Cloud backup</h2>
            <p className="lede-line">
                After every grind, the grinder uploads the session to your cloud store over WiFi —
                your full history, beyond the device&apos;s own storage, viewable in Analytics from
                any device.
            </p>

            <div className="btn-row">
                <button
                    type="button"
                    className="btn btn-accent"
                    disabled={cloudBusy}
                    onClick={setUpCloudBackup}
                >
                    Set Up Cloud Backup
                </button>
                <button type="button" className="btn-ghost" onClick={checkCloud}>
                    Check Status
                </button>
                <button type="button" className="btn-ghost danger" onClick={forgetCloud}>
                    Forget Sync
                </button>
            </div>

            <StatusBox status={cloudStatus} />
        </div>
    );
}
