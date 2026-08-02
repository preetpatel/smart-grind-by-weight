'use client';

// Cloud store link/state bar for the Analytics page (docs/CLOUD_SYNC.md).
import {
    buildShareLink,
    type CloudConfig,
    clearCloudConfig,
    createCloudStore,
    deleteCloudStore,
    getCloudConfig,
} from '@/lib/client/cloud';

export function CloudBar({
    config,
    onConfigChange,
    onSync,
    onBackfill,
    onStatus,
    hasRecords,
}: {
    config: CloudConfig | null;
    onConfigChange: () => void;
    onSync: () => void;
    onBackfill: () => void;
    onStatus: (text: string, kind: 'info' | 'success' | 'error') => void;
    hasRecords: boolean;
}) {
    const setUp = async () => {
        try {
            await createCloudStore(null);
            onConfigChange();
            onStatus(
                'Cloud store created. Sessions you pull are now backed up automatically.',
                'success',
            );
            if (hasRecords) onBackfill();
        } catch (error) {
            onStatus(
                `${error instanceof Error ? error.message : error}. Cloud backup needs the hosted app (or your self-hosted server).`,
                'error',
            );
        }
    };

    const disconnect = () => {
        if (!config) return;
        const warning = config.uploadKey
            ? 'Disconnect this browser from the cloud store? The store and its data stay on the server, ' +
              'but this browser holds the only upload key — without a provisioned grinder, copy the ' +
              'dashboard link first or the store becomes unreachable.'
            : 'Disconnect this browser from the cloud store? You can re-link with the dashboard link.';
        if (!window.confirm(warning)) return;
        clearCloudConfig();
        onConfigChange();
        onStatus('Disconnected from the cloud store.', 'info');
    };

    const destroy = async () => {
        if (!config?.uploadKey) return;
        if (
            !window.confirm(
                'Permanently delete the cloud store and every session in it? Local data in this browser is kept.',
            )
        ) {
            return;
        }
        try {
            await deleteCloudStore(config);
            clearCloudConfig();
            onConfigChange();
            onStatus('Cloud store deleted.', 'info');
        } catch (error) {
            onStatus(`Delete failed: ${error instanceof Error ? error.message : error}`, 'error');
        }
    };

    const copyLink = async () => {
        if (!config) return;
        try {
            await navigator.clipboard.writeText(buildShareLink(config));
            onStatus(
                'Dashboard link copied — anyone with it can view (not modify) this store.',
                'success',
            );
        } catch {
            onStatus(`Dashboard link: ${buildShareLink(config)}`, 'info');
        }
    };

    if (!config) {
        return (
            <div className="analytics-toolbar">
                <button type="button" className="btn-ghost" onClick={setUp}>
                    Set up cloud backup
                </button>
                <span className="store-line">
                    Keep your full grind history beyond the grinder&apos;s own storage.
                </span>
            </div>
        );
    }

    return (
        <div className="analytics-toolbar">
            <span className="store-line">
                cloud store {config.storeId}
                {config.uploadKey ? '' : ' · read-only link'}
            </span>
            <button type="button" className="btn-ghost" onClick={onSync}>
                Sync from cloud
            </button>
            {config.uploadKey && (
                <button type="button" className="btn-ghost" onClick={onBackfill}>
                    Back up local sessions
                </button>
            )}
            <button type="button" className="btn-ghost" onClick={copyLink}>
                Copy dashboard link
            </button>
            <button type="button" className="btn-ghost" onClick={disconnect}>
                Disconnect
            </button>
            {config.uploadKey && (
                <button type="button" className="btn-ghost danger" onClick={destroy}>
                    Delete cloud store
                </button>
            )}
        </div>
    );
}

export { getCloudConfig };
