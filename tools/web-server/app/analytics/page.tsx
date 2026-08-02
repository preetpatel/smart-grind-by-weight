'use client';

// Analytics overview: the last grind, how the machine has been doing overall,
// and a way into the detail. Everything else lives in its own section now.
import { Activity, ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { useAnalytics } from '@/components/analytics/analytics-provider';
import { Hero } from '@/components/analytics/hero';
import { RecentSessions } from '@/components/analytics/recent-sessions';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';

export default function AnalyticsOverviewPage() {
    const { records, loaded, deviceSessions, loggingOff, lastPull } = useAnalytics();

    if (!loaded) return null;

    if (!records.length) {
        return (
            <>
                <PageHeader title="Analytics" />
                <EmptyState
                    icon={Activity}
                    title="No grind data in this browser yet"
                    description={
                        deviceSessions
                            ? `Your grinder is holding ${deviceSessions} sessions. Pull them over Bluetooth to see how it has been performing.`
                            : 'Pull data from the grinder over Bluetooth, sync from a cloud store, or import a JSON export.'
                    }
                />
            </>
        );
    }

    const totalEvents = records.reduce((sum, r) => sum + r.events.length, 0);
    const totalMeasurements = records.reduce((sum, r) => sum + r.measurements.length, 0);

    return (
        <>
            <PageHeader
                title="Analytics"
                description={
                    <>
                        {records.length} sessions · {totalEvents.toLocaleString()} events ·{' '}
                        {totalMeasurements.toLocaleString()} measurements in this browser
                        {lastPull ? ` · last pull ${new Date(lastPull).toLocaleString()}` : ''}
                    </>
                }
            />

            {loggingOff && (
                <p className="mb-5 text-caution text-sm">
                    Grind logging is off on the device — new grinds are not being recorded. Turn it
                    back on under Menu → Logs &amp; Data on the grinder.
                </p>
            )}

            <Hero records={records} />

            <div className="mt-10">
                <div className="mb-3 flex items-baseline justify-between gap-4">
                    <h2 className="font-medium text-base">Recent grinds</h2>
                    <Button
                        variant="ghost"
                        size="sm"
                        nativeButton={false}
                        render={<Link href="/analytics/sessions" />}
                    >
                        All {records.length} sessions
                        <ArrowRight />
                    </Button>
                </div>
                <RecentSessions records={records} limit={8} />
            </div>
        </>
    );
}
