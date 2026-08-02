'use client';

// My Grinder: everything about the device itself, ordered by the ownership
// journey — install, update, configure, troubleshoot.
import { useEffect, useState } from 'react';
import { DiagnosticsPanel } from '@/components/grinder/diagnostics-panel';
import { GetStartedPanel } from '@/components/grinder/get-started-panel';
import { UpdatePanel } from '@/components/grinder/update-panel';
import { WifiSyncPanel } from '@/components/grinder/wifi-sync-panel';
import { SubTabs } from '@/components/ui';
import { hasSeenGrinder, isSupported } from '@/lib/client/ble';

const PANELS = [
    { key: 'initial', label: 'Get Started' },
    { key: 'ota', label: 'Update' },
    { key: 'wifi', label: 'WiFi & Sync' },
    { key: 'diagnostics', label: 'Diagnostics' },
] as const;

type PanelKey = (typeof PANELS)[number]['key'];

export default function GrinderPage() {
    const [panel, setPanel] = useState<PanelKey>('initial');
    const [supported, setSupported] = useState(true);

    // Returning owners land on Update; new visitors on Get Started. Decided
    // client-side (localStorage) after mount.
    useEffect(() => {
        setSupported(isSupported());
        if (isSupported() && hasSeenGrinder()) setPanel('ota');
    }, []);

    return (
        <div>
            {!supported && (
                <div className="browser-support">
                    <h3>Browser not supported</h3>
                    <p>
                        This tool needs <strong>Chrome</strong> (or Edge) for Web Bluetooth and Web
                        Serial. iOS browsers and Firefox can&apos;t connect to the grinder.
                    </p>
                </div>
            )}

            <SubTabs tabs={PANELS} active={panel} onChange={setPanel} deviceNav />

            {panel === 'initial' && <GetStartedPanel onGoToWifi={() => setPanel('wifi')} />}
            {panel === 'ota' && <UpdatePanel />}
            {panel === 'wifi' && <WifiSyncPanel />}
            {panel === 'diagnostics' && <DiagnosticsPanel />}
        </div>
    );
}
