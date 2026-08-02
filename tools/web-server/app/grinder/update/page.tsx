'use client';

import { UpdatePanel } from '@/components/grinder/update-panel';
import { PageHeader } from '@/components/page-header';
import { UnsupportedBrowser } from '@/components/unsupported-browser';

export default function UpdatePage() {
    return (
        <>
            <PageHeader title="Update" />
            <UnsupportedBrowser />
            <UpdatePanel />
        </>
    );
}
