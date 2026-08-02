'use client';

import { UpdatePanel } from '@/components/grinder/update-panel';
import { PageHeader } from '@/components/page-header';
import { UnsupportedBrowser } from '@/components/unsupported-browser';

export default function UpdatePage() {
    return (
        <>
            <PageHeader
                title="Update"
                description="Wireless firmware update over Bluetooth. Keep the grinder powered and nearby until it reboots."
            />
            <UnsupportedBrowser />
            <UpdatePanel />
        </>
    );
}
