'use client';

// First-time USB install via esp-web-tools. The install button custom
// element is loaded from unpkg (same as the original flasher).
import Script from 'next/script';
import { useState } from 'react';
import { FirmwareSelect, useReleases } from './firmware-select';

export function GetStartedPanel({ onGoToWifi }: { onGoToWifi: () => void }) {
    const { entries, error } = useReleases();
    const [showRc, setShowRc] = useState(false);
    const [tag, setTag] = useState('');

    const manifest = entries.find((entry) => entry.tag === tag)?.manifest ?? undefined;

    return (
        <div className="form-stack">
            <Script
                type="module"
                src="https://unpkg.com/esp-web-tools@10/dist/web/install-button.js?module"
            />
            <h2>Install over USB</h2>
            <p className="lede-line">
                First-time install with a USB cable. Already installed? Use Update — no cable
                needed.
            </p>

            {error && <div className="status error">Failed to load the firmware list: {error}</div>}

            <div className="form-group">
                <label htmlFor="usbFirmwareSelect">Firmware version</label>
                <FirmwareSelect
                    entries={entries}
                    kind="manifest"
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

            <esp-web-install-button manifest={manifest}>
                <button type="button" slot="activate" className="btn">
                    Flash via USB
                </button>
                <span slot="unsupported">
                    Your browser does not support installing on ESP devices. Use Chrome or Edge.
                </span>
                <span slot="not-allowed">Installing only works over HTTPS or on localhost.</span>
            </esp-web-install-button>

            <p className="next-step">
                Flashed successfully? Next:{' '}
                <button type="button" className="link-inline" onClick={onGoToWifi}>
                    set up WiFi
                </button>{' '}
                so the grinder&apos;s clock stays synced.
            </p>
        </div>
    );
}
