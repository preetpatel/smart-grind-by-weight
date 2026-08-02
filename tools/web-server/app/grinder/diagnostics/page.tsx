'use client';

import { DiagnosticsPanel } from '@/components/grinder/diagnostics-panel';
import { PageHeader } from '@/components/page-header';
import { UnsupportedBrowser } from '@/components/unsupported-browser';

export default function DiagnosticsPage() {
    return (
        <>
            <PageHeader
                title="Diagnostics"
                description="Live health report straight off the device — calibration, load-cell noise, task timing and the last OTA outcome."
            />
            <UnsupportedBrowser />
            <DiagnosticsPanel />
        </>
    );
}
