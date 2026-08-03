'use client';

// The working surface for bags of coffee. The active bean is where the
// numbers live — shot count, deviation trend, the current verdict — because
// this page is where you act on them (edit the ratio, switch bags). The shelf
// stays a quiet list below. Design: mockups/brew-feature-mockups.html (B).
//
// Server-authoritative: every mutation is an owner API call followed by a
// cache refresh, plus a best-effort BLE push so the grinder's post-shot
// screen picks the change up immediately instead of on its next WiFi sync.
import { Bean as BeanIcon, Bluetooth, Ellipsis, Plus } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAnalytics } from '@/components/analytics/analytics-provider';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { PlotlyChart } from '@/components/plotly-chart';
import { type StatusMessage, StatusRegion } from '@/components/status-region';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
    adviceForShots,
    adviceSentence,
    bagStats,
    beanShotCount,
    brewDeviationFigure,
    brewShots,
} from '@/lib/analytics/brew';
import type { Bean } from '@/lib/analytics/types';
import { type BeanPushResult, pushBeanToGrinder } from '@/lib/client/bean-push';
import {
    activateBean,
    type BeanDraft,
    type CloudSource,
    createBean,
    deleteBean,
    updateBean,
} from '@/lib/client/cloud';

function shortDate(value: string | null): string | null {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime())
        ? value
        : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function ratioLabel(ratio: number): string {
    return `1 : ${ratio}`;
}

// Add/edit form. Ratio and shot time are the two numbers the grinder's
// post-shot screen is built on, so they sit right under the name.
function BeanDialog({
    open,
    onOpenChange,
    title,
    initial,
    onSubmit,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    initial: Bean | null;
    onSubmit: (draft: BeanDraft) => void;
}) {
    const [name, setName] = useState('');
    const [ratio, setRatio] = useState('1.5');
    const [brewTime, setBrewTime] = useState('30');
    const [bagSize, setBagSize] = useState('');
    const [roastDate, setRoastDate] = useState('');
    const [notes, setNotes] = useState('');

    useEffect(() => {
        if (!open) return;
        setName(initial?.name ?? '');
        setRatio(String(initial?.ratio ?? 1.5));
        setBrewTime(String(initial?.brew_time_s ?? 30));
        setBagSize(initial?.bag_size_g ? String(initial.bag_size_g) : '');
        setRoastDate(initial?.roast_date ?? '');
        setNotes(initial?.notes ?? '');
    }, [open, initial]);

    const parsedRatio = Number.parseFloat(ratio);
    const parsedTime = Number.parseInt(brewTime, 10);
    const parsedBag = bagSize.trim() ? Number.parseFloat(bagSize) : null;
    const valid =
        name.trim().length > 0 &&
        Number.isFinite(parsedRatio) &&
        parsedRatio >= 0.1 &&
        parsedRatio <= 10 &&
        Number.isInteger(parsedTime) &&
        parsedTime >= 5 &&
        parsedTime <= 600 &&
        (parsedBag === null ||
            (Number.isFinite(parsedBag) && parsedBag >= 10 && parsedBag <= 10000));

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                <form
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (!valid) return;
                        onSubmit({
                            name: name.trim(),
                            ratio: parsedRatio,
                            brew_time_s: parsedTime,
                            bag_size_g: parsedBag === null ? null : Math.round(parsedBag),
                            roast_date: roastDate.trim() || null,
                            notes: notes.trim() || null,
                        });
                        onOpenChange(false);
                    }}
                >
                    <DialogHeader>
                        <DialogTitle>{title}</DialogTitle>
                    </DialogHeader>
                    <div className="my-5 grid gap-4">
                        <div className="grid gap-2">
                            <Label htmlFor="bean-name">Name</Label>
                            <Input
                                id="bean-name"
                                value={name}
                                onChange={(event) => setName(event.target.value)}
                                placeholder="Atomic Veloce"
                                autoFocus
                            />
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            <div className="grid gap-2">
                                <Label htmlFor="bean-ratio">Ratio (1 : x)</Label>
                                <Input
                                    id="bean-ratio"
                                    type="number"
                                    step="0.05"
                                    min="0.1"
                                    max="10"
                                    className="font-mono"
                                    value={ratio}
                                    onChange={(event) => setRatio(event.target.value)}
                                />
                            </div>
                            <div className="grid gap-2">
                                <Label htmlFor="bean-time">Shot time (s)</Label>
                                <Input
                                    id="bean-time"
                                    type="number"
                                    min="5"
                                    max="600"
                                    className="font-mono"
                                    value={brewTime}
                                    onChange={(event) => setBrewTime(event.target.value)}
                                />
                            </div>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            <div className="grid gap-2">
                                <Label htmlFor="bean-bag">Bag size (g)</Label>
                                <Input
                                    id="bean-bag"
                                    type="number"
                                    min="10"
                                    max="10000"
                                    placeholder="250"
                                    className="font-mono"
                                    value={bagSize}
                                    onChange={(event) => setBagSize(event.target.value)}
                                />
                            </div>
                            <div className="grid gap-2">
                                <Label htmlFor="bean-roast">Roast date</Label>
                                <Input
                                    id="bean-roast"
                                    type="date"
                                    className="font-mono"
                                    value={roastDate}
                                    onChange={(event) => setRoastDate(event.target.value)}
                                />
                            </div>
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor="bean-notes">Notes</Label>
                            <Input
                                id="bean-notes"
                                value={notes}
                                onChange={(event) => setNotes(event.target.value)}
                                placeholder="Washed, chocolatey"
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
                        <Button type="submit" disabled={!valid}>
                            Save
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

export function BeansPanel() {
    const { beans, activeBeanId, records, annotations, loaded, source, refreshBeans } =
        useAnalytics();
    const [status, setStatus] = useState<StatusMessage | null>(null);
    const [dialog, setDialog] = useState<{ title: string; bean: Bean | null } | null>(null);
    const [deleting, setDeleting] = useState<Bean | null>(null);
    const [pushState, setPushState] = useState<BeanPushResult | 'idle'>('idle');

    const owned = source?.owned ?? false;
    const active = beans.find((bean) => bean.id === activeBeanId) ?? null;
    const shelf = useMemo(
        () =>
            beans
                .filter((bean) => bean.id !== activeBeanId)
                .sort((a, b) => Number(a.archived) - Number(b.archived)),
        [beans, activeBeanId],
    );

    const activeShots = useMemo(
        () => (active ? brewShots(records, annotations, active) : []),
        [records, annotations, active],
    );
    const advice = useMemo(() => adviceForShots(activeShots), [activeShots]);
    const lastShot = activeShots[activeShots.length - 1];
    const bag = useMemo(
        () => (active ? bagStats(records, annotations, active) : null),
        [records, annotations, active],
    );

    // The BLE push is a convenience beside the WiFi path, so its failures
    // downgrade to "it'll sync later", never to an error.
    const pushActive = useCallback(async (bean: Bean | null, interactive = false) => {
        setPushState(await pushBeanToGrinder(bean, { interactive }));
    }, []);

    const mutate = useCallback(
        async (action: (source: CloudSource) => Promise<void>, failure: string) => {
            if (!source?.owned) return false;
            try {
                await action(source);
                await refreshBeans();
                setStatus(null);
                return true;
            } catch (error) {
                setStatus({
                    text: `${failure}: ${error instanceof Error ? error.message : error}`,
                    kind: 'error',
                });
                return false;
            }
        },
        [source, refreshBeans],
    );

    if (!loaded) return null;

    if (!source) {
        return (
            <>
                <PageHeader title="Beans" />
                <EmptyState
                    icon={BeanIcon}
                    title="Beans live with your backup"
                    action={
                        <Button nativeButton={false} render={<Link href="/grinder/wifi" />}>
                            Set up backup
                        </Button>
                    }
                />
            </>
        );
    }

    // State or control, never mechanism: confirmed delivery is a fact,
    // a too-old firmware is a terse precondition, and everything else is
    // just the button. The WiFi fallback needs no narration.
    const pushLine = (() => {
        if (!owned || !active) return null;
        if (pushState === 'pushed') {
            return (
                <span className="flex items-center gap-2">
                    <span className="size-2 rounded-full bg-success" />
                    On the grinder
                </span>
            );
        }
        if (pushState === 'unsupported') {
            return (
                <span className="flex items-center gap-2">
                    <span className="size-2 rounded-full bg-caution" />
                    Firmware too old
                </span>
            );
        }
        return (
            <Button
                variant="ghost"
                size="sm"
                className="-ml-2.5"
                onClick={() => pushActive(active, true)}
            >
                <Bluetooth />
                Push to grinder
            </Button>
        );
    })();

    return (
        <>
            <PageHeader
                title="Beans"
                actions={
                    owned ? (
                        <Button onClick={() => setDialog({ title: 'Add bean', bean: null })}>
                            <Plus />
                            Add bean
                        </Button>
                    ) : null
                }
            />
            <StatusRegion status={status} />

            {beans.length === 0 ? (
                <EmptyState
                    icon={BeanIcon}
                    title="No beans yet"
                    description="With a bag active, the grinder asks for each shot's output."
                    action={
                        owned ? (
                            <Button onClick={() => setDialog({ title: 'Add bean', bean: null })}>
                                <Plus />
                                Add bean
                            </Button>
                        ) : null
                    }
                />
            ) : (
                <>
                    <section className="border-b pb-8">
                        {active ? (
                            <>
                                <div className="flex items-center gap-3">
                                    <h2 className="min-w-0 truncate font-semibold text-xl">
                                        {active.name}
                                    </h2>
                                    <Badge
                                        variant="outline"
                                        className="border-primary/40 font-mono text-primary"
                                    >
                                        ACTIVE
                                    </Badge>
                                    {owned && (
                                        <div className="ml-auto flex shrink-0 items-center gap-1">
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                onClick={() =>
                                                    setDialog({ title: 'Edit bean', bean: active })
                                                }
                                            >
                                                Edit
                                            </Button>
                                            <DropdownMenu>
                                                <DropdownMenuTrigger
                                                    render={
                                                        <Button
                                                            variant="ghost"
                                                            size="icon-sm"
                                                            aria-label="Bean actions"
                                                        >
                                                            <Ellipsis />
                                                        </Button>
                                                    }
                                                />
                                                <DropdownMenuContent align="end">
                                                    <DropdownMenuItem
                                                        onClick={() =>
                                                            mutate(
                                                                (s) =>
                                                                    updateBean(s, active.id, {
                                                                        archived: true,
                                                                    }).then(() => undefined),
                                                                'Could not archive',
                                                            ).then((ok) => {
                                                                if (ok) pushActive(null);
                                                            })
                                                        }
                                                    >
                                                        Finish bag
                                                    </DropdownMenuItem>
                                                    <DropdownMenuItem
                                                        variant="destructive"
                                                        onClick={() => setDeleting(active)}
                                                    >
                                                        Delete
                                                    </DropdownMenuItem>
                                                </DropdownMenuContent>
                                            </DropdownMenu>
                                        </div>
                                    )}
                                </div>
                                <p className="mt-1 font-mono text-muted-foreground text-sm tabular-nums">
                                    {ratioLabel(active.ratio)} · {active.brew_time_s} s
                                    {active.roast_date
                                        ? ` · roasted ${shortDate(active.roast_date)}`
                                        : ''}
                                    {active.notes ? ` · ${active.notes}` : ''}
                                </p>
                                {bag?.sizeG != null && bag.remainingG != null && (
                                    <div className="mt-3 flex max-w-md items-center gap-3">
                                        <div className="h-1 min-w-16 flex-1 overflow-hidden rounded-full bg-muted">
                                            <div
                                                className={`h-full rounded-full ${bag.low ? 'bg-caution' : 'bg-primary'}`}
                                                style={{
                                                    width: `${Math.min(100, Math.max(2, (bag.remainingG / bag.sizeG) * 100))}%`,
                                                }}
                                            />
                                        </div>
                                        <span
                                            className={`shrink-0 font-mono text-sm tabular-nums ${bag.low ? 'text-caution' : 'text-muted-foreground'}`}
                                        >
                                            {bag.remainingG} g · {bag.shotsRemaining} shots left
                                        </span>
                                    </div>
                                )}
                                {pushLine && (
                                    <div className="mt-2 text-muted-foreground text-sm">
                                        {pushLine}
                                    </div>
                                )}

                                <div className="mt-6 flex flex-wrap gap-x-10 gap-y-3">
                                    <div>
                                        <div className="font-mono text-xl tabular-nums">
                                            {beanShotCount(annotations, active.id)}
                                        </div>
                                        <div className="mt-0.5 text-muted-foreground text-xs">
                                            shots
                                        </div>
                                    </div>
                                    <div>
                                        <div
                                            className={`font-mono text-xl tabular-nums ${
                                                advice.verdict === 'finer' ||
                                                advice.verdict === 'coarser'
                                                    ? 'text-caution'
                                                    : ''
                                            }`}
                                        >
                                            {advice.median_deviation_pct === null
                                                ? '—'
                                                : `${advice.median_deviation_pct > 0 ? '+' : ''}${advice.median_deviation_pct}%`}
                                        </div>
                                        <div className="mt-0.5 text-muted-foreground text-xs">
                                            median, last {Math.max(advice.shots_considered, 1)}
                                        </div>
                                    </div>
                                    <div>
                                        <div className="font-mono text-xl tabular-nums">
                                            {lastShot
                                                ? `${lastShot.deviationPct > 0 ? '+' : ''}${lastShot.deviationPct.toFixed(1)}%`
                                                : '—'}
                                        </div>
                                        <div className="mt-0.5 text-muted-foreground text-xs">
                                            last shot
                                        </div>
                                    </div>
                                </div>

                                <p className="mt-5 flex items-center gap-2 text-sm">
                                    {advice.verdict === 'finer' || advice.verdict === 'coarser' ? (
                                        <>
                                            <span className="size-2 shrink-0 rounded-full bg-caution" />
                                            {adviceSentence(active, advice)}
                                        </>
                                    ) : advice.verdict === 'ok' ? (
                                        <>
                                            {/* The number already sits in the stat
                                                row; repeating it here was noise. */}
                                            <span className="size-2 shrink-0 rounded-full bg-success" />
                                            On target.
                                        </>
                                    ) : (
                                        <span className="text-muted-foreground">
                                            A verdict appears after 3 logged shots.
                                        </span>
                                    )}
                                </p>

                                {activeShots.length >= 2 && (
                                    <div className="mt-6">
                                        <p className="mb-1 text-muted-foreground text-xs">
                                            Deviation from expected output, per shot
                                        </p>
                                        <PlotlyChart
                                            figure={brewDeviationFigure(activeShots)}
                                            compact
                                        />
                                    </div>
                                )}
                            </>
                        ) : (
                            <p className="text-muted-foreground text-sm">
                                No active bean — the grinder skips the shot log until one is set.
                            </p>
                        )}
                    </section>

                    {shelf.length > 0 && (
                        <section className="py-6">
                            <h2 className="font-medium text-base">Shelf</h2>
                            <div className="mt-3">
                                {shelf.map((bean) => (
                                    <div
                                        key={bean.id}
                                        className="group flex items-center gap-4 border-b py-2.5 last:border-b-0"
                                    >
                                        <div className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                                            <span
                                                className={`min-w-0 truncate text-sm ${bean.archived ? 'text-muted-foreground' : ''}`}
                                            >
                                                {bean.name}
                                            </span>
                                            <span className="min-w-0 truncate font-mono text-muted-foreground text-sm tabular-nums sm:text-right">
                                                {ratioLabel(bean.ratio)} · {bean.brew_time_s} s ·{' '}
                                                {beanShotCount(annotations, bean.id)} shots
                                                {bean.archived ? ' · finished' : ''}
                                            </span>
                                        </div>
                                        {owned && (
                                            <div className="flex shrink-0 items-center gap-1 opacity-100 transition-opacity focus-within:opacity-100 sm:opacity-70 sm:group-hover:opacity-100">
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    onClick={() =>
                                                        mutate(
                                                            (s) => activateBean(s, bean.id),
                                                            'Could not set active',
                                                        ).then((ok) => {
                                                            if (ok) {
                                                                pushActive({
                                                                    ...bean,
                                                                    archived: false,
                                                                });
                                                            }
                                                        })
                                                    }
                                                >
                                                    Set active
                                                </Button>
                                                <DropdownMenu>
                                                    <DropdownMenuTrigger
                                                        render={
                                                            <Button
                                                                variant="ghost"
                                                                size="icon-sm"
                                                                aria-label={`Actions for ${bean.name}`}
                                                            >
                                                                <Ellipsis />
                                                            </Button>
                                                        }
                                                    />
                                                    <DropdownMenuContent align="end">
                                                        <DropdownMenuItem
                                                            onClick={() =>
                                                                setDialog({
                                                                    title: 'Edit bean',
                                                                    bean,
                                                                })
                                                            }
                                                        >
                                                            Edit
                                                        </DropdownMenuItem>
                                                        <DropdownMenuItem
                                                            onClick={() =>
                                                                mutate(
                                                                    (s) =>
                                                                        updateBean(s, bean.id, {
                                                                            archived:
                                                                                !bean.archived,
                                                                        }).then(() => undefined),
                                                                    'Could not update',
                                                                )
                                                            }
                                                        >
                                                            {bean.archived
                                                                ? 'Back on the shelf'
                                                                : 'Finish bag'}
                                                        </DropdownMenuItem>
                                                        <DropdownMenuItem
                                                            variant="destructive"
                                                            onClick={() => setDeleting(bean)}
                                                        >
                                                            Delete
                                                        </DropdownMenuItem>
                                                    </DropdownMenuContent>
                                                </DropdownMenu>
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </section>
                    )}
                </>
            )}

            <BeanDialog
                open={dialog !== null}
                onOpenChange={(open) => !open && setDialog(null)}
                title={dialog?.title ?? 'Add bean'}
                initial={dialog?.bean ?? null}
                onSubmit={(draft) => {
                    const editing = dialog?.bean;
                    mutate(
                        (s) =>
                            editing
                                ? updateBean(s, editing.id, draft).then(() => undefined)
                                : createBean(s, draft).then(() => undefined),
                        editing ? 'Could not save' : 'Could not add bean',
                    ).then((ok) => {
                        if (!ok) return;
                        // The grinder only cares when the change touches the
                        // bag it's grinding for.
                        if (editing && editing.id === activeBeanId) {
                            pushActive({ ...editing, ...draft } as Bean);
                        } else if (!editing && beans.length === 0) {
                            pushActive({ archived: false, ...draft } as Bean);
                        }
                    });
                }}
            />
            <ConfirmDialog
                open={deleting !== null}
                onOpenChange={(open) => !open && setDeleting(null)}
                title={deleting ? `Delete ${deleting.name}?` : 'Delete bean?'}
                description="Grinds keep their history; only the bag and its attribution go away."
                confirmLabel="Delete"
                destructive
                onConfirm={() => {
                    const bean = deleting;
                    setDeleting(null);
                    if (!bean) return;
                    mutate((s) => deleteBean(s, bean.id), 'Could not delete').then((ok) => {
                        if (ok && bean.id === activeBeanId) pushActive(null);
                    });
                }}
            />
        </>
    );
}
