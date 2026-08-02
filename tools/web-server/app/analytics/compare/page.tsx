'use client';

import { GitCompare, Plug } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { useAnalytics } from '@/components/analytics/analytics-provider';
import { CompareView } from '@/components/analytics/trends-views';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';

// useSearchParams opts a route out of static prerendering unless it sits
// behind a Suspense boundary, so the reader is split out from the page.
function CompareBody() {
    const { records, loaded, busy, pullData } = useAnalytics();
    const params = useSearchParams();
    if (!loaded) return null;

    // ?sessions=12,13 arrives from a selection made in the sessions table.
    const initialSessionIds = (params.get('sessions') ?? '')
        .split(',')
        .map((value) => Number.parseInt(value, 10))
        .filter((value) => Number.isFinite(value));

    if (!records.length) {
        return (
            <EmptyState
                icon={GitCompare}
                title="Needs at least two grinds"
                action={
                    <Button disabled={busy} onClick={() => pullData()}>
                        <Plug />
                        Pull grinds
                    </Button>
                }
            />
        );
    }
    return <CompareView records={records} initialSessionIds={initialSessionIds} />;
}

export default function ComparePage() {
    return (
        <>
            <PageHeader title="Compare" />
            <Suspense fallback={null}>
                <CompareBody />
            </Suspense>
        </>
    );
}
