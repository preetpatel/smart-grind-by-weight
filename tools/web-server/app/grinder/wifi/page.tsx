'use client';

import { WifiSyncPanel } from '@/components/grinder/wifi-sync-panel';
import { PageHeader } from '@/components/page-header';
import { UnsupportedBrowser } from '@/components/unsupported-browser';

export default function WifiPage() {
    return (
        <>
            <PageHeader title="WiFi & Backup" />
            <UnsupportedBrowser />
            <WifiSyncPanel />
        </>
    );
}
