'use client';

// Where this dashboard's data comes from (docs/CLOUD_SYNC.md). Three states:
// signed-out prompt, an owned store with a picker, or a read-only viewer link.
// One line of chrome — the actions live behind a menu because none of them is
// something you reach for often.
import { Cloud, CloudUpload, Copy, Ellipsis, Link2Off, RefreshCw, ShieldOff } from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { StatusDot } from '@/components/status-dot';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import {
    buildShareLink,
    type CloudSource,
    clearViewerSource,
    type OwnedStore,
    rotateViewKey,
    setActiveStoreId,
} from '@/lib/client/cloud';

export function CloudBar({
    source,
    ownedStores,
    signedIn,
    onSourcesChanged,
    onSync,
    onBackfill,
    onStatus,
}: {
    source: CloudSource | null;
    ownedStores: OwnedStore[];
    signedIn: boolean;
    onSourcesChanged: () => void;
    onSync: () => void;
    onBackfill: () => void;
    onStatus: (text: string, kind: 'info' | 'success' | 'error', action?: ReactNode) => void;
}) {
    const [confirmRotate, setConfirmRotate] = useState(false);

    const copyLink = async () => {
        if (!source) return;
        const { toast } = await import('sonner');
        try {
            await navigator.clipboard.writeText(buildShareLink(source));
            toast.success('Share link copied', {
                description: 'Anyone with it can read your grinds.',
            });
        } catch {
            onStatus(`Share link: ${buildShareLink(source)}`, 'info');
        }
    };

    const revokeLinks = async () => {
        if (!source) return;
        try {
            await rotateViewKey(source.storeId);
            onSourcesChanged();
            // The grinder holds the old key, so it needs setting up again —
            // said with the control that does it rather than directions to it.
            onStatus(
                'Share links revoked.',
                'success',
                <Button
                    variant="outline"
                    size="sm"
                    nativeButton={false}
                    render={<Link href="/grinder/wifi" />}
                >
                    Set up the grinder again
                </Button>,
            );
        } catch (error) {
            onStatus(`Couldn’t revoke: ${error instanceof Error ? error.message : error}`, 'error');
        }
    };

    if (!source) {
        return (
            <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2 border-b pb-4 text-sm">
                <StatusDot tone="neutral" />
                <span className="text-muted-foreground">Not backed up — this browser only.</span>
                {/* A store belongs to a grinder, so setting one up starts at
                    the grinder rather than here. */}
                <Button
                    variant="ghost"
                    size="sm"
                    nativeButton={false}
                    render={<Link href={signedIn ? '/grinder/wifi' : '/signin'} />}
                >
                    <Cloud />
                    {signedIn ? 'Turn on backup' : 'Sign in to back up'}
                </Button>
            </div>
        );
    }

    return (
        <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2 border-b pb-4 text-sm">
            <StatusDot tone="success" />
            {source.owned && ownedStores.length > 1 ? (
                <Select
                    value={source.storeId}
                    onValueChange={(value) => {
                        if (!value) return;
                        setActiveStoreId(value);
                        onSourcesChanged();
                    }}
                    items={Object.fromEntries(
                        ownedStores.map((store) => [store.store_id, store.name ?? store.store_id]),
                    )}
                >
                    <SelectTrigger size="sm" className="w-56">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {ownedStores.map((store) => (
                            <SelectItem key={store.store_id} value={store.store_id}>
                                {store.name ?? store.store_id}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            ) : (
                <span className="text-muted-foreground">
                    {source.owned ? 'Backing up to ' : 'Reading '}
                    <span className="font-medium text-foreground">
                        {source.name ?? source.storeId}
                    </span>
                    {source.owned ? '' : ' · read-only'}
                </span>
            )}

            <div className="flex-1" />

            <Button variant="ghost" size="sm" onClick={onSync}>
                <RefreshCw />
                Sync
            </Button>

            <DropdownMenu>
                <DropdownMenuTrigger
                    render={
                        <Button variant="ghost" size="icon-sm" aria-label="Backup actions">
                            <Ellipsis />
                        </Button>
                    }
                />
                <DropdownMenuContent align="end" className="w-60">
                    {source.owned && (
                        <DropdownMenuItem onClick={onBackfill}>
                            <CloudUpload />
                            Back up local grinds
                        </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onClick={copyLink}>
                        <Copy />
                        Copy share link
                    </DropdownMenuItem>
                    {source.owned && (
                        <DropdownMenuItem onClick={() => setConfirmRotate(true)}>
                            <ShieldOff />
                            Revoke share links
                        </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    {source.owned ? (
                        <DropdownMenuItem render={<Link href="/account" />}>
                            Manage stores
                        </DropdownMenuItem>
                    ) : (
                        <DropdownMenuItem
                            variant="destructive"
                            onClick={() => {
                                clearViewerSource();
                                onSourcesChanged();
                                onStatus('Disconnected.', 'info');
                            }}
                        >
                            <Link2Off />
                            Disconnect
                        </DropdownMenuItem>
                    )}
                </DropdownMenuContent>
            </DropdownMenu>

            <ConfirmDialog
                open={confirmRotate}
                onOpenChange={setConfirmRotate}
                title="Revoke every share link?"
                description="Every link you've shared stops working, and the grinder needs setting up again. No grinds are deleted."
                confirmLabel="Revoke links"
                destructive
                onConfirm={() => revokeLinks()}
            />
        </div>
    );
}
