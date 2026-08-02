'use client';

import { useAnalytics } from '@/components/analytics/analytics-provider';
import { HealthView } from '@/components/analytics/health-view';
import { PageHeader } from '@/components/page-header';

export default function HealthPage() {
    const { deviceReports } = useAnalytics();
    return (
        <>
            <PageHeader title="Health" />
            <HealthView deviceReports={deviceReports} />
        </>
    );
}
