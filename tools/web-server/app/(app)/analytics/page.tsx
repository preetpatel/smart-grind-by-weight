'use client';

// Analytics overview: the last grind, how the machine has been doing overall,
// and a way into the detail. Everything else lives in its own section now.
import { Activity, ArrowRight, Plug } from 'lucide-react';
import Link from 'next/link';
import { useMemo } from 'react';
import { useAnalytics } from '@/components/analytics/analytics-provider';
import { Hero } from '@/components/analytics/hero';
import { RecentSessions } from '@/components/analytics/recent-sessions';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { adviceForShots, adviceSentence, brewShots } from '@/lib/analytics/brew';

export default function AnalyticsOverviewPage() {
    const {
        records,
        annotations,
        beans,
        activeBeanId,
        loaded,
        deviceSessions,
        loggingOff,
        lastPull,
        busy,
        pullData,
    } = useAnalytics();

    // The dial-in verdict for the bag in the hopper, surfaced where you land.
    const beanAdvice = useMemo(() => {
        const active = beans.find((bean) => bean.id === activeBeanId);
        if (!active) return null;
        const sentence = adviceSentence(
            active,
            adviceForShots(brewShots(records, annotations, active)),
        );
        return sentence;
    }, [beans, activeBeanId, records, annotations]);

    if (!loaded) return null;

    if (!records.length) {
        return (
            <>
                <PageHeader title="Analytics" />
                <EmptyState
                    icon={Activity}
                    title="No grinds here yet"
                    description={
                        deviceSessions ? `${deviceSessions} waiting on the grinder.` : null
                    }
                    action={
                        <Button disabled={busy} onClick={() => pullData()}>
                            <Plug />
                            Pull grinds
                        </Button>
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
                        {records.length} grinds · {totalEvents.toLocaleString()} events ·{' '}
                        {totalMeasurements.toLocaleString()} measurements
                        {lastPull ? ` · last pull ${new Date(lastPull).toLocaleString()}` : ''}
                    </>
                }
            />

            {loggingOff && (
                <p className="mb-5 text-caution text-sm">
                    Logging is off — new grinds aren&apos;t recorded. Grinder → Menu → Logs &amp;
                    Data.
                </p>
            )}

            {beanAdvice && (
                <p className="mb-5 flex flex-wrap items-center gap-2 text-sm">
                    <span className="size-2 shrink-0 rounded-full bg-caution" />
                    {beanAdvice}
                    <Button
                        variant="ghost"
                        size="sm"
                        nativeButton={false}
                        render={<Link href="/analytics/beans" />}
                    >
                        View beans
                        <ArrowRight />
                    </Button>
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
                        All {records.length} grinds
                        <ArrowRight />
                    </Button>
                </div>
                <RecentSessions records={records} limit={8} />
            </div>
        </>
    );
}
