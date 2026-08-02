'use client';

import { TrendingUp } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useAnalytics } from '@/components/analytics/analytics-provider';
import { type SettingChange, TrendsView } from '@/components/analytics/trends-views';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { Label } from '@/components/ui/label';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';

const ALL_BEANS = 'all';

export default function TrendsPage() {
    const { records, deviceReports, loaded, annotations } = useAnalytics();
    const [bean, setBean] = useState(ALL_BEANS);

    const beans = useMemo(() => {
        const names = new Set<string>();
        for (const entry of annotations.values()) if (entry.bean) names.add(entry.bean);
        return [...names].sort();
    }, [annotations]);

    const filtered = useMemo(
        () =>
            bean === ALL_BEANS
                ? records
                : records.filter((record) => annotations.get(record.sha256)?.bean === bean),
        [records, annotations, bean],
    );

    // Where the grind setting changed from one session to the next, in session
    // order — those are the moments the curves below should step.
    const settingChanges = useMemo<SettingChange[]>(() => {
        const ordered = [...filtered].sort((a, b) => a.session_id - b.session_id);
        const changes: SettingChange[] = [];
        let previous: string | null = null;
        for (const record of ordered) {
            const setting = annotations.get(record.sha256)?.grind_setting ?? null;
            if (setting && setting !== previous) {
                // The first annotated grind establishes a baseline rather than
                // marking a change.
                if (previous !== null) {
                    changes.push({ sessionId: record.session_id, setting });
                }
                previous = setting;
            }
        }
        return changes;
    }, [filtered, annotations]);

    if (!loaded) return null;

    return (
        <>
            <PageHeader
                title="Trends"
                description="How the grinder is changing over time — accuracy drift, flow rate decay and burr wear. Annotated grind-setting changes are marked on every chart."
            />

            {beans.length > 0 && (
                <div className="mb-5 flex items-center gap-2">
                    <Label htmlFor="trends-bean" className="font-normal text-muted-foreground">
                        Bean
                    </Label>
                    <Select
                        value={bean}
                        onValueChange={(value) => setBean(value ?? ALL_BEANS)}
                        // Base UI's Select.Value renders the raw value unless
                        // the Root is given the value→label map.
                        items={{
                            [ALL_BEANS]: 'All beans',
                            ...Object.fromEntries(beans.map((name) => [name, name])),
                        }}
                    >
                        <SelectTrigger id="trends-bean" size="sm" className="w-56">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value={ALL_BEANS}>All beans</SelectItem>
                            {beans.map((option) => (
                                <SelectItem key={option} value={option}>
                                    {option}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
            )}

            {filtered.length ? (
                <TrendsView
                    records={filtered}
                    deviceReports={deviceReports}
                    settingChanges={settingChanges}
                />
            ) : (
                <EmptyState
                    icon={TrendingUp}
                    title={records.length ? 'No grinds for that bean' : 'Not enough history yet'}
                    description={
                        records.length
                            ? 'Pick another bean, or annotate more grinds to build its history.'
                            : 'Trends need a run of grinds over time. Pull data from the grinder to start building one.'
                    }
                />
            )}
        </>
    );
}
