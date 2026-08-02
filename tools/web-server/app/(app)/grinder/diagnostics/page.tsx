'use client';

import { DiagnosticsPanel } from '@/components/grinder/diagnostics-panel';
import { PageHeader } from '@/components/page-header';
import { UnsupportedBrowser } from '@/components/unsupported-browser';

export default function DiagnosticsPage() {
    return (
        <>
            <PageHeader title="Diagnostics" />
            <UnsupportedBrowser />
            <DiagnosticsPanel />
        </>
    );
}
