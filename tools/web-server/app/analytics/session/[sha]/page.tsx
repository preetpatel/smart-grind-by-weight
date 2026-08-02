'use client';

// One grind, in full. The session is addressable by its content hash, so a
// link to a specific grind survives re-pulls, cloud syncs and factory resets.
import { ArrowLeft, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useAnalytics } from '@/components/analytics/analytics-provider';
import { AnnotationEditor } from '@/components/analytics/annotation-editor';
import { OverallTab } from '@/components/analytics/overall-tab';
import {
    ControllerTab,
    PredictiveTab,
    PulseTab,
    VibrationTab,
} from '@/components/analytics/single-views';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { sessionStartLabel } from '@/lib/analytics/labels';

const SMOOTHING_OPTIONS: Array<[string, number]> = [
    ['None', 0],
    ['100 ms', 100],
    ['500 ms', 500],
    ['1000 ms', 1000],
    ['1500 ms', 1500],
];

export default function SessionPage() {
    const params = useParams<{ sha: string }>();
    const router = useRouter();
    const { records, loaded, annotations, saveAnnotation, deleteSession, source } = useAnalytics();
    const [includeTaring, setIncludeTaring] = useState(false);
    const [smoothingMs, setSmoothingMs] = useState(500);
    const [confirmDelete, setConfirmDelete] = useState(false);

    // Suggestions come from what has already been typed, so the vocabulary
    // grows with use instead of being configured up front.
    const suggestions = useMemo(() => {
        const beans = new Set<string>();
        const settings = new Set<string>();
        for (const entry of annotations.values()) {
            if (entry.bean) beans.add(entry.bean);
            if (entry.grind_setting) settings.add(entry.grind_setting);
        }
        return { beans: [...beans].sort(), settings: [...settings].sort() };
    }, [annotations]);

    if (!loaded) return null;

    const record = records.find((r) => r.sha256 === params.sha);
    if (!record) {
        return (
            <>
                <PageHeader title="Session not found" />
                <EmptyState
                    title="This grind isn't in this browser"
                    description="It may have been cleared, or the link came from a different store. Pull again or sync from the cloud."
                    action={
                        <Button
                            variant="outline"
                            nativeButton={false}
                            render={<Link href="/analytics/sessions" />}
                        >
                            <ArrowLeft />
                            All sessions
                        </Button>
                    }
                />
            </>
        );
    }

    const options = { includeTaring, smoothingMs };

    return (
        <>
            <PageHeader
                title={`Session #${record.session.session_id}`}
                description={sessionStartLabel(record.session)}
                actions={
                    <Button
                        variant="ghost"
                        size="sm"
                        nativeButton={false}
                        render={<Link href="/analytics/sessions" />}
                    >
                        <ArrowLeft />
                        All sessions
                    </Button>
                }
            />

            <div className="mb-5 flex flex-wrap items-center gap-x-6 gap-y-3 border-b pb-4">
                <div className="flex items-center gap-2">
                    <Checkbox
                        id="include-taring"
                        checked={includeTaring}
                        onCheckedChange={(checked) => setIncludeTaring(checked === true)}
                    />
                    <Label htmlFor="include-taring" className="font-normal text-muted-foreground">
                        Include taring
                    </Label>
                </div>
                <div className="flex items-center gap-2">
                    <Label htmlFor="flow-smoothing" className="font-normal text-muted-foreground">
                        Flow smoothing
                    </Label>
                    <Select
                        value={String(smoothingMs)}
                        onValueChange={(value) => setSmoothingMs(Number(value))}
                        items={Object.fromEntries(
                            SMOOTHING_OPTIONS.map(([label, value]) => [String(value), label]),
                        )}
                    >
                        <SelectTrigger id="flow-smoothing" size="sm" className="w-32">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {SMOOTHING_OPTIONS.map(([label, value]) => (
                                <SelectItem key={value} value={String(value)}>
                                    {label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
            </div>

            <Tabs defaultValue="overall">
                <TabsList>
                    <TabsTrigger value="overall">Overall</TabsTrigger>
                    <TabsTrigger value="predictive">Predictive</TabsTrigger>
                    <TabsTrigger value="pulse">Pulse</TabsTrigger>
                    <TabsTrigger value="vibration">Vibration</TabsTrigger>
                    <TabsTrigger value="controller">Controller</TabsTrigger>
                </TabsList>
                <TabsContent value="overall">
                    <OverallTab record={record} {...options} />
                </TabsContent>
                <TabsContent value="predictive">
                    <PredictiveTab record={record} {...options} />
                </TabsContent>
                <TabsContent value="pulse">
                    <PulseTab record={record} {...options} />
                </TabsContent>
                <TabsContent value="vibration">
                    <VibrationTab record={record} includeTaring={includeTaring} />
                </TabsContent>
                <TabsContent value="controller">
                    <ControllerTab record={record} includeTaring={includeTaring} />
                </TabsContent>
            </Tabs>

            <AnnotationEditor
                annotation={annotations.get(record.sha256)}
                beanSuggestions={suggestions.beans}
                settingSuggestions={suggestions.settings}
                onSave={(patch) => saveAnnotation(record.sha256, patch)}
            />

            <ConfirmDialog
                open={confirmDelete}
                onOpenChange={setConfirmDelete}
                title={`Delete grind #${record.session.session_id}?`}
                description={
                    source?.owned
                        ? 'Removed from this browser and from your cloud store for good — the grinder will not be able to upload it again. Its own copy on the device is untouched.'
                        : 'Removed from this browser. The grinder keeps its own copy, so pulling again will bring it back.'
                }
                confirmLabel="Delete grind"
                destructive
                onConfirm={async () => {
                    await deleteSession(record.sha256);
                    router.push('/analytics/sessions');
                }}
            />
        </>
    );
}
