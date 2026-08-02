'use client';

import { WifiSyncPanel } from '@/components/grinder/wifi-sync-panel';
import { PageHeader } from '@/components/page-header';
import { UnsupportedBrowser } from '@/components/unsupported-browser';

export default function WifiPage() {
    return (
        <>
            <PageHeader
                title="WiFi & Sync"
                description="Give the grinder your network so its clock stays right without a phone nearby, and point it at a cloud store to back up every grind."
            />
            <UnsupportedBrowser />
            <WifiSyncPanel />
        </>
    );
}
