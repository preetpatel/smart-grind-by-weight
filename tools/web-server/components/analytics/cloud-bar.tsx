'use client';

// Cloud source bar for the Analytics page (docs/CLOUD_SYNC.md). Three
// states: signed-out prompt, owned store(s) with a picker, or a read-only
// viewer link (share link / BLE claim).
import Link from 'next/link';
import {
    buildShareLink,
    type CloudSource,
    clearViewerSource,
    createCloudStore,
    type OwnedStore,
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
    const setUp = async () => {
        try {
            await createCloudStore(null);
            onSourcesChanged();
            onStatus(
                'Cloud store created. Sessions you pull are now backed up automatically — ' +
                    'provision your grinder under My Grinder → WiFi & Sync so it uploads on its own.',
                'success',
            );
            if (hasRecords) onBackfill();
        } catch (error) {
            onStatus(`${error instanceof Error ? error.message : error}`, 'error');
        }
    };

    const copyLink = async () => {
        if (!source) return;
        try {
            await navigator.clipboard.writeText(buildShareLink(source));
            onStatus(
                'Dashboard link copied — anyone with it can view (not modify) this store.',
                'success',
            );
        } catch {
            onStatus(`Dashboard link: ${buildShareLink(source)}`, 'info');
        }
    };

    if (!source) {
        return (
            <div className="analytics-toolbar">
                {signedIn ? (
                    <button type="button" className="btn-ghost" onClick={setUp}>
                        Set up cloud backup
                    </button>
                ) : (
                    <Link href="/signin" className="btn-ghost">
                        Sign in for cloud backup
                    </Link>
                )}
                <span className="store-line">
                    Keep your full grind history beyond the grinder&apos;s own storage, on every
                    browser you sign in to.
                </span>
            </div>
        );
    }

    return (
        <div className="analytics-toolbar">
            {source.owned && ownedStores.length > 1 ? (
                <select
                    value={source.storeId}
                    onChange={(e) => {
                        setActiveStoreId(e.target.value);
                        onSourcesChanged();
                    }}
                >
                    {ownedStores.map((store) => (
                        <option key={store.store_id} value={store.store_id}>
                            {store.name ?? store.store_id}
                        </option>
                    ))}
                </select>
            ) : (
                <span className="store-line">
                    cloud store {source.name ?? source.storeId}
                    {source.owned ? '' : ' · read-only link'}
                </span>
            )}
            <button type="button" className="btn-ghost" onClick={onSync}>
                Sync from cloud
            </button>
            {source.owned && (
                <button type="button" className="btn-ghost" onClick={onBackfill}>
                    Back up local sessions
                </button>
            )}
            <button type="button" className="btn-ghost" onClick={copyLink}>
                Copy dashboard link
            </button>
            {source.owned ? (
                <Link href="/account" className="btn-ghost">
                    Manage
                </Link>
            ) : (
                <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => {
                        clearViewerSource();
                        onSourcesChanged();
                        onStatus('Disconnected from the shared store.', 'info');
                    }}
                >
                    Disconnect
                </button>
            )}
        </div>
    );
}
