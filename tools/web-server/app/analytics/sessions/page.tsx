'use client';

import { ListFilter } from 'lucide-react';
import { useAnalytics } from '@/components/analytics/analytics-provider';
import { SessionsDataTable } from '@/components/analytics/sessions-data-table';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';

export default function SessionsPage() {
    const { records, loaded } = useAnalytics();

    if (!loaded) return null;

    return (
        <>
            <PageHeader
                title="Sessions"
                description="Every grind this browser knows about. Open one for its full analysis, or select a few and send them to Compare."
            />
            {records.length ? (
                <SessionsDataTable records={records} />
            ) : (
                <EmptyState
                    icon={ListFilter}
                    title="No sessions yet"
                    description="Pull data from the grinder, sync a cloud store, or import a JSON export."
                />
            )}
        </>
    );
}
