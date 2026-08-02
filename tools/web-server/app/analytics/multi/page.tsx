'use client';

import { Layers } from 'lucide-react';
import { useAnalytics } from '@/components/analytics/analytics-provider';
import { MultiView } from '@/components/analytics/multi-view';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';

export default function MultiPage() {
    const { records, loaded } = useAnalytics();
    if (!loaded) return null;

    return (
        <>
            <PageHeader
                title="Multi-Session"
                description="Accuracy, timing and pulse behaviour across every stored grind at once."
            />
            {records.length ? (
                <MultiView records={records} />
            ) : (
                <EmptyState
                    icon={Layers}
                    title="No sessions to summarise"
                    description="Pull data from the grinder to see how it performs across many grinds."
                />
            )}
        </>
    );
}
