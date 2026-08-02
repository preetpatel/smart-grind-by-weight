'use client';

// Where this dashboard's data comes from (docs/CLOUD_SYNC.md). Three states:
// signed-out prompt, an owned store with a picker, or a read-only viewer link.
// One line of chrome — the actions live behind a menu because none of them is
// something you reach for often.
import { Cloud, CloudUpload, Copy, Ellipsis, Link2Off, RefreshCw, ShieldOff } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
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
    createCloudStore,
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
    hasRecords,
}: {
    source: CloudSource | null;
    ownedStores: OwnedStore[];
    signedIn: boolean;
    onSourcesChanged: () => void;
    onSync: () => void;
    onBackfill: () => void;
    onStatus: (text: string, kind: 'info' | 'success' | 'error') => void;
    hasRecords: boolean;
}) {
    const [confirmRotate, setConfirmRotate] = useState(false);

    const setUp = async () => {
        try {
            await createCloudStore(null);
            onSourcesChanged();
            onStatus(
                'Cloud store created. Sessions you pull are backed up automatically from now on — ' +
                    'provision the grinder under WiFi & Sync so it uploads on its own too.',
                'success',
            );
            if (hasRecords) onBackfill();
        } catch (error) {
            onStatus(`${error instanceof Error ? error.message : error}`, 'error');
        }
    };

    const copyLink = async () => {
        if (!source) return;
        const { toast } = await import('sonner');
        try {
            await navigator.clipboard.writeText(buildShareLink(source));
            toast.success('Dashboard link copied', {
                description: 'Anyone with it can read this store, but not change it.',
            });
        } catch {
            onStatus(`Dashboard link: ${buildShareLink(source)}`, 'info');
        }
    };

    const revokeLinks = async () => {
        if (!source) return;
        try {
            await rotateViewKey(source.storeId);
            onSourcesChanged();
            onStatus(
                'Previous dashboard links no longer work. Re-provision the grinder under ' +
                    'WiFi & Sync so it picks up the new key.',
                'success',
            );
        } catch (error) {
            onStatus(
                `Could not revoke: ${error instanceof Error ? error.message : error}`,
                'error',
            );
        }
    };

    if (!source) {
        return (
            <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2 border-b pb-4 text-sm">
                <StatusDot tone="neutral" />
                <span className="text-muted-foreground">
                    Not backed up — this data lives only in this browser.
                </span>
                {signedIn ? (
                    <Button variant="ghost" size="sm" onClick={setUp}>
                        <Cloud />
                        Set up cloud backup
                    </Button>
                ) : (
                    <Button
                        variant="ghost"
                        size="sm"
                        nativeButton={false}
                        render={<Link href="/signin" />}
                    >
                        <Cloud />
                        Sign in to back up
                    </Button>
                )}
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
                    {source.owned ? '' : ' · read-only link'}
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
                        <Button variant="ghost" size="icon-sm" aria-label="Cloud store actions">
                            <Ellipsis />
                        </Button>
                    }
                />
                <DropdownMenuContent align="end" className="w-60">
                    {source.owned && (
                        <DropdownMenuItem onClick={onBackfill}>
                            <CloudUpload />
                            Back up local sessions
                        </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onClick={copyLink}>
                        <Copy />
                        Copy dashboard link
                    </DropdownMenuItem>
                    {source.owned && (
                        <DropdownMenuItem onClick={() => setConfirmRotate(true)}>
                            <ShieldOff />
                            Revoke shared links
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
                                onStatus('Disconnected from the shared store.', 'info');
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
                title="Revoke every shared dashboard link?"
                description="A new view key is minted, so any link you have handed out stops working immediately. Your grinder holds the old key too — re-provision it under WiFi & Sync afterwards, or its own claim will fail. No grind data is deleted."
                confirmLabel="Revoke links"
                destructive
                onConfirm={() => revokeLinks()}
            />
        </div>
    );
}
