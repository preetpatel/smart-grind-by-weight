'use client';

import { ListFilter } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useAnalytics } from '@/components/analytics/analytics-provider';
import { SessionsTable } from '@/components/analytics/sessions-table';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';

export default function SessionsPage() {
    const { records, loaded } = useAnalytics();
    const router = useRouter();

    if (!loaded) return null;

    return (
        <>
            <PageHeader
                title="Sessions"
                description="Every grind this browser knows about. Open one to see its full analysis."
            />
            {records.length ? (
                <SessionsTable
                    records={records}
                    selectedSha={null}
                    onSelect={(sha) => sha && router.push(`/analytics/session/${sha}`)}
                />
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
