'use client';

import { GitCompare } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useAnalytics } from '@/components/analytics/analytics-provider';
import { CompareView } from '@/components/analytics/trends-views';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';

export default function ComparePage() {
    const { records, loaded } = useAnalytics();
    const params = useSearchParams();
    if (!loaded) return null;

    // ?sessions=12,13 arrives from a selection made in the sessions table.
    const initialSessionIds = (params.get('sessions') ?? '')
        .split(',')
        .map((value) => Number.parseInt(value, 10))
        .filter((value) => Number.isFinite(value));

    return (
        <>
            <PageHeader
                title="Compare"
                description="Overlay grinds on one time axis to see how consistently the machine repeats itself."
            />
            {records.length ? (
                <CompareView records={records} initialSessionIds={initialSessionIds} />
            ) : (
                <EmptyState
                    icon={GitCompare}
                    title="Nothing to compare yet"
                    description="Pull at least two grinds from the grinder to overlay them."
                />
            )}
        </>
    );
}
