'use client';

import { useAnalytics } from '@/components/analytics/analytics-provider';
import { HealthView } from '@/components/analytics/health-view';
import { PageHeader } from '@/components/page-header';

export default function HealthPage() {
    const { deviceReports } = useAnalytics();
    return (
        <>
            <PageHeader
                title="Device Health"
                description="The health snapshot captured with the last data pull — firmware, memory, task timing, hardware and the full diagnostic report."
            />
            <HealthView deviceReports={deviceReports} />
        </>
    );
}
