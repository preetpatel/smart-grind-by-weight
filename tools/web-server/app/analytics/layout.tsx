'use client';

// Shared chrome for every analytics section: the data toolbar, the cloud
// source bar, and the one status region. State lives in AnalyticsProvider so
// switching sections never re-reads IndexedDB or drops a sync in flight.
import type { ReactNode } from 'react';
import { AnalyticsProvider, useAnalytics } from '@/components/analytics/analytics-provider';
import { AnalyticsToolbar } from '@/components/analytics/analytics-toolbar';
import { CloudBar } from '@/components/analytics/cloud-bar';
import { StatusRegion } from '@/components/status-region';

function AnalyticsChrome({ children }: { children: ReactNode }) {
    const {
        status,
        progress,
        source,
        ownedStores,
        signedIn,
        refreshSources,
        syncFromCloud,
        backfillToCloud,
        showStatus,
    } = useAnalytics();

    return (
        <>
            <AnalyticsToolbar />
            <CloudBar
                source={source}
                ownedStores={ownedStores}
                signedIn={signedIn}
                onSourcesChanged={() => refreshSources()}
                onSync={() => syncFromCloud()}
                onBackfill={() => backfillToCloud()}
                onStatus={(text, kind) => showStatus(text, kind)}
            />
            <StatusRegion status={status} progress={progress} />
            {children}
        </>
    );
}

export default function AnalyticsLayout({ children }: { children: ReactNode }) {
    return (
        <AnalyticsProvider>
            <AnalyticsChrome>{children}</AnalyticsChrome>
        </AnalyticsProvider>
    );
}
