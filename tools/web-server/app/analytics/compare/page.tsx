'use client';

import { GitCompare } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { useAnalytics } from '@/components/analytics/analytics-provider';
import { CompareView } from '@/components/analytics/trends-views';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';

// useSearchParams opts a route out of static prerendering unless it sits
// behind a Suspense boundary, so the reader is split out from the page.
function CompareBody() {
    const { records, loaded } = useAnalytics();
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
                title="Nothing to compare yet"
                description="Pull at least two grinds from the grinder to overlay them."
            />
        );
    }
    return <CompareView records={records} initialSessionIds={initialSessionIds} />;
}

export default function ComparePage() {
    return (
        <>
            <PageHeader
                title="Compare"
                description="Overlay grinds on one time axis to see how consistently the machine repeats itself."
            />
            <Suspense fallback={null}>
                <CompareBody />
            </Suspense>
        </>
    );
}
