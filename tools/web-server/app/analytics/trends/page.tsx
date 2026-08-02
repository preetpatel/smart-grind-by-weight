'use client';

import { TrendingUp } from 'lucide-react';
import { useAnalytics } from '@/components/analytics/analytics-provider';
import { TrendsView } from '@/components/analytics/trends-views';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';

export default function TrendsPage() {
    const { records, deviceReports, loaded } = useAnalytics();
    if (!loaded) return null;

    return (
        <>
            <PageHeader
                title="Trends"
                description="How the grinder is changing over time — accuracy drift, flow rate decay and burr wear."
            />
            {records.length ? (
                <TrendsView records={records} deviceReports={deviceReports} />
            ) : (
                <EmptyState
                    icon={TrendingUp}
                    title="Not enough history yet"
                    description="Trends need a run of grinds over time. Pull data from the grinder to start building one."
                />
            )}
        </>
    );
}
