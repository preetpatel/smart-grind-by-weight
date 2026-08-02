'use client';

import { GitCompare } from 'lucide-react';
import { useAnalytics } from '@/components/analytics/analytics-provider';
import { CompareView } from '@/components/analytics/trends-views';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';

export default function ComparePage() {
    const { records, loaded } = useAnalytics();
    if (!loaded) return null;

    return (
        <>
            <PageHeader
                title="Compare"
                description="Overlay grinds on one time axis to see how consistently the machine repeats itself."
            />
            {records.length ? (
                <CompareView records={records} />
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
