'use client';

import { ListFilter, Plug } from 'lucide-react';
import { useAnalytics } from '@/components/analytics/analytics-provider';
import { SessionsDataTable } from '@/components/analytics/sessions-data-table';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';

export default function SessionsPage() {
    const { records, loaded, annotations, busy, pullData } = useAnalytics();

    if (!loaded) return null;

    return (
        <>
            <PageHeader
                title="Grinds"
                description={records.length ? `${records.length} grinds` : undefined}
            />
            {records.length ? (
                <SessionsDataTable records={records} annotations={annotations} />
            ) : (
                <EmptyState
                    icon={ListFilter}
                    title="No grinds here yet"
                    action={
                        <Button disabled={busy} onClick={() => pullData()}>
                            <Plug />
                            Pull grinds
                        </Button>
                    }
                />
            )}
        </>
    );
}
