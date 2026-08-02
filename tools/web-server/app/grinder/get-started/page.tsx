'use client';

import { useRouter } from 'next/navigation';
import { GetStartedPanel } from '@/components/grinder/get-started-panel';
import { PageHeader } from '@/components/page-header';
import { UnsupportedBrowser } from '@/components/unsupported-browser';

export default function GetStartedPage() {
    const router = useRouter();
    return (
        <>
            <PageHeader
                title="Get Started"
                description="First-time install over a USB cable. Already running the firmware? Use Update — no cable needed."
            />
            <UnsupportedBrowser />
            <GetStartedPanel onGoToWifi={() => router.push('/grinder/wifi')} />
        </>
    );
}
