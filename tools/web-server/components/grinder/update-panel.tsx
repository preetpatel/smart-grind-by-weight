'use client';

// Wireless firmware update over BLE (React port of the flasher's OTA flow).
import { useState } from 'react';
import { ProgressBar, StatusBox, type StatusMessage } from '@/components/ui';
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
            setStatus({ text: 'Please select a firmware version', kind: 'error' });
            return;
        }
        if (!supported) {
            setStatus({ text: 'Web Bluetooth not supported in this browser', kind: 'error' });
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
        <div className="form-stack">
            <h2>Update firmware</h2>
            <p className="lede-line">
                Wireless, over Bluetooth. First-time installs use Get Started instead.
            </p>

            {deviceVersion && latest && (
                <div className={`status ${updateAvailable ? 'warning' : 'success'}`}>
                    {updateAvailable
                        ? `Update available: v${latest.version} — your grinder runs v${deviceVersion}.`
                        : `Your grinder is on the latest firmware (v${deviceVersion}).`}
                </div>
            )}
            {error && <div className="status error">Failed to load the firmware list: {error}</div>}

            <div className="form-group">
                <label htmlFor="firmwareSelect">Firmware version</label>
                <FirmwareSelect
                    entries={entries}
                    kind="ota"
                    showPrereleases={showRc}
                    selectedTag={tag}
                    onSelect={setTag}
                />
                <label className="check-line">
                    <input
                        type="checkbox"
                        checked={showRc}
                        onChange={(e) => setShowRc(e.target.checked)}
                    />
                    Show release candidates (RC, beta, alpha)
                </label>
            </div>

            <button type="button" className="btn" disabled={busy} onClick={flash}>
                Connect &amp; Flash Firmware
            </button>

            <StatusBox status={status} />
            <ProgressBar percent={progress} />
        </div>
    );
}
