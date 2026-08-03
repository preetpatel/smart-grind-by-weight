'use client';

// Shared chrome for every analytics section: the data toolbar, the cloud
// source bar, and the one status region. State lives in AnalyticsProvider so
// switching sections never re-reads IndexedDB or drops a sync in flight.
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { AnalyticsProvider, useAnalytics } from '@/components/analytics/analytics-provider';
import { AnalyticsToolbar } from '@/components/analytics/analytics-toolbar';
import { CloudBar } from '@/components/analytics/cloud-bar';
import { StatusRegion } from '@/components/status-region';

function AnalyticsChrome({ children }: { children: ReactNode }) {
    const {
        status,
        statusAction,
        progress,
        source,
        ownedStores,
        signedIn,
        refreshSources,
        syncFromCloud,
        backfillToCloud,
        showStatus,
    } = useAnalytics();

    // Beans is a management surface, not a data view: the pull/export toolbar
    // and the backup bar would sit above a page whose one action is Add bean.
    // The status region stays — a sync kicked off elsewhere still reports here.
    const pathname = usePathname();
    const dataChrome = !pathname.startsWith('/analytics/beans');

    return (
        <>
            {dataChrome && <AnalyticsToolbar />}
            {dataChrome && (
                <CloudBar
                    source={source}
                    ownedStores={ownedStores}
                    signedIn={signedIn}
                    onSourcesChanged={() => refreshSources()}
                    onSync={() => syncFromCloud()}
                    onBackfill={() => backfillToCloud()}
                    onStatus={(text, kind, action) => showStatus(text, kind, action)}
                />
            )}
            <StatusRegion status={status} progress={progress} action={statusAction} />
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
