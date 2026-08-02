'use client';

import { Layers, Plug } from 'lucide-react';
import { useAnalytics } from '@/components/analytics/analytics-provider';
import { MultiView } from '@/components/analytics/multi-view';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';

export default function MultiPage() {
    const { records, loaded, busy, pullData } = useAnalytics();
    if (!loaded) return null;

    return (
        <>
            <PageHeader
                title="Aggregate"
                description={records.length ? `${records.length} grinds` : undefined}
            />
            {records.length ? (
                <MultiView records={records} />
            ) : (
                <EmptyState
                    icon={Layers}
                    title="Nothing to summarise yet"
                    action={
                        <Button disabled={busy} onClick={() => pullData()}>
                            <Plug />
                            Pull grinds
                        </Button>
                    }
                />
            )}
        </>
    );
}
