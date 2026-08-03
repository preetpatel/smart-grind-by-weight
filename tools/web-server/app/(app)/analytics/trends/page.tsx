'use client';

import { Plug, TrendingUp } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useAnalytics } from '@/components/analytics/analytics-provider';
import { type SettingChange, TrendsView } from '@/components/analytics/trends-views';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
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
    const {
        records,
        deviceReports,
        loaded,
        annotations,
        beans: registeredBeans,
        busy,
        pullData,
    } = useAnalytics();
    const [bean, setBean] = useState(ALL_BEANS);

    // Registered beans filter by id (attribution is stamped at ingest); the
    // free-text names remain only for stores that never registered any.
    const beanOptions = useMemo(() => {
        if (registeredBeans.length) {
            return registeredBeans.map((entry) => ({ value: entry.id, label: entry.name }));
        }
        const names = new Set<string>();
        for (const entry of annotations.values()) if (entry.bean) names.add(entry.bean);
        return [...names].sort().map((name) => ({ value: name, label: name }));
    }, [registeredBeans, annotations]);

    const filtered = useMemo(() => {
        if (bean === ALL_BEANS) return records;
        return records.filter((record) => {
            const note = annotations.get(record.sha256);
            return registeredBeans.length ? note?.bean_id === bean : note?.bean === bean;
        });
    }, [records, annotations, bean, registeredBeans]);

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
            <PageHeader title="Trends" />

            {beanOptions.length > 0 && (
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
                            ...Object.fromEntries(
                                beanOptions.map((option) => [option.value, option.label]),
                            ),
                        }}
                    >
                        <SelectTrigger id="trends-bean" size="sm" className="w-56">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value={ALL_BEANS}>All beans</SelectItem>
                            {beanOptions.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                    {option.label}
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
                    action={
                        records.length ? undefined : (
                            <Button disabled={busy} onClick={() => pullData()}>
                                <Plug />
                                Pull grinds
                            </Button>
                        )
                    }
                />
            )}
        </>
    );
}
