'use client';

// All analytics state in one place, mounted by app/analytics/layout.tsx so
// moving between sections never re-reads IndexedDB or loses the cloud source.
// Previously this lived inline in a single 599-line page component.
import {
    createContext,
    type ReactNode,
    use,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import type { StatusMessage } from '@/components/status-region';
import {
    buildExportJson,
    clearAll,
    loadMeta,
    loadSessions,
    parseImportJson,
    saveMeta,
    saveSessions,
} from '@/lib/analytics/store';
import type { DeviceReports, StoredRecord } from '@/lib/analytics/types';
import { authClient } from '@/lib/client/auth';
import * as ble from '@/lib/client/ble';
import {
    adoptShareFragment,
    type CloudSource,
    getActiveStoreId,
    getViewerSource,
    listMyStores,
    type OwnedStore,
    pullFromCloud,
    pushSnapshotToCloud,
    pushToCloud,
    saveViewerSource,
    type ViewerSource,
} from '@/lib/client/cloud';
import { GrinderDataClient } from '@/lib/client/data-export';
import { useGrinder } from '@/lib/client/use-grinder';

interface AnalyticsState {
    records: StoredRecord[];
    deviceReports: DeviceReports | null;
    lastPull: string | null;
    status: StatusMessage | null;
    progress: number | null;
    busy: boolean;
    loaded: boolean;
    source: CloudSource | null;
    ownedStores: OwnedStore[];
    signedIn: boolean;
    deviceSessions: number | undefined;
    loggingOff: boolean;
    showStatus: (text: string, kind?: StatusMessage['kind']) => void;
    clearStatus: () => void;
    pullData: () => Promise<void>;
    exportJson: () => void;
    importJson: (file: File) => Promise<void>;
    clearStoredData: () => Promise<void>;
    syncFromCloud: (options?: { silent?: boolean }) => Promise<void>;
    backfillToCloud: (options?: { silent?: boolean }) => Promise<void>;
    refreshSources: () => Promise<void>;
}

const AnalyticsContext = createContext<AnalyticsState | null>(null);

export function useAnalytics(): AnalyticsState {
    const value = use(AnalyticsContext);
    if (!value) throw new Error('useAnalytics must be used inside <AnalyticsProvider>');
    return value;
}

export function AnalyticsProvider({ children }: { children: ReactNode }) {
    const grinder = useGrinder();
    const [records, setRecords] = useState<StoredRecord[]>([]);
    const [deviceReports, setDeviceReports] = useState<DeviceReports | null>(null);
    const [lastPull, setLastPull] = useState<string | null>(null);
    const [status, setStatus] = useState<StatusMessage | null>(null);
    const [progress, setProgress] = useState<number | null>(null);
    const [busy, setBusy] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const [ownedStores, setOwnedStores] = useState<OwnedStore[]>([]);
    const [viewer, setViewer] = useState<ViewerSource | null>(null);
    const recordsRef = useRef<StoredRecord[]>([]);
    recordsRef.current = records;

    const { data: session, isPending: sessionPending } = authClient.useSession();
    const signedIn = Boolean(session?.user);

    // Source resolution: owned stores (via login) win over a viewer link.
    const source: CloudSource | null = useMemo(() => {
        if (ownedStores.length) {
            const activeId = getActiveStoreId();
            const store = ownedStores.find((s) => s.store_id === activeId) ?? ownedStores[0];
            if (store) {
                return {
                    storeId: store.store_id,
                    viewKey: store.view_key,
                    baseUrl: '',
                    owned: true,
                    name: store.name,
                };
            }
        }
        if (viewer) {
            return {
                storeId: viewer.storeId,
                viewKey: viewer.viewKey,
                baseUrl: viewer.baseUrl,
                owned: false,
            };
        }
        return null;
    }, [ownedStores, viewer]);
    const sourceRef = useRef<CloudSource | null>(source);
    sourceRef.current = source;

    const showStatus = useCallback(
        (text: string, kind: StatusMessage['kind'] = 'info') => setStatus({ text, kind }),
        [],
    );
    const clearStatus = useCallback(() => setStatus(null), []);

    const refreshSources = useCallback(async () => {
        setViewer(getViewerSource());
        if (signedIn) {
            try {
                setOwnedStores(await listMyStores());
                return;
            } catch {
                // Not signed in after all / API unreachable — fall through.
            }
        }
        setOwnedStores([]);
    }, [signedIn]);

    const loadFromStore = useCallback(async () => {
        const stored = await loadSessions();
        setRecords(stored);
        setDeviceReports(await loadMeta<DeviceReports>('deviceReports'));
        setLastPull(await loadMeta<string>('lastPull'));
        setLoaded(true);
        return stored;
    }, []);

    const activeDeviceId = useCallback((): string | null => {
        const id = grinder.active?.snapshot?.system?.device_id;
        return typeof id === 'string' ? id : null;
    }, [grinder.active]);

    const syncFromCloud = useCallback(
        async ({ silent = false } = {}) => {
            const activeSource = sourceRef.current;
            if (!activeSource) return;
            try {
                if (!silent) showStatus('Checking the cloud store...');
                const known = new Set(recordsRef.current.map((r) => r.sha256));
                const {
                    records: fetched,
                    errors,
                    cloudTotal,
                } = await pullFromCloud(activeSource, known, (p) => {
                    showStatus(p.message);
                    if (p.total) setProgress((p.index / p.total) * 100);
                });
                if (fetched.length) {
                    await saveSessions(fetched);
                    await saveMeta('lastPull', new Date().toISOString());
                    await loadFromStore();
                }
                if (errors.length) {
                    showStatus(
                        `Cloud sync: ${fetched.length} sessions added, ${errors.length} failed.`,
                        'warning',
                    );
                } else if (fetched.length) {
                    showStatus(
                        `Synced ${fetched.length} sessions from the cloud (${cloudTotal} in the store).`,
                        'success',
                    );
                } else if (!silent) {
                    showStatus('Local data already matches the cloud store.', 'success');
                }
            } catch (error) {
                if (!silent) {
                    showStatus(
                        `Cloud sync failed: ${error instanceof Error ? error.message : error}`,
                        'error',
                    );
                }
                console.error('Cloud sync error:', error);
            } finally {
                setProgress(null);
            }
        },
        [loadFromStore, showStatus],
    );

    // Push any locally-held sessions the store is missing (verbatim raw bytes;
    // the server dedups by content hash, so always safe to re-run).
    const backfillToCloud = useCallback(
        async ({ silent = false } = {}) => {
            const activeSource = sourceRef.current;
            if (!activeSource?.owned) return;
            try {
                const { stored, errors } = await pushToCloud(
                    activeSource,
                    recordsRef.current,
                    activeDeviceId(),
                    (p) => {
                        showStatus(p.message);
                        if (p.total) setProgress((p.index / p.total) * 100);
                    },
                );
                if (errors.length) {
                    showStatus(
                        `Cloud backup: ${stored} sessions uploaded, ${errors.length} failed.`,
                        'warning',
                    );
                } else if (stored) {
                    showStatus(`Backed up ${stored} sessions to the cloud.`, 'success');
                } else if (!silent) {
                    showStatus('The cloud store already holds every local session.', 'success');
                }
            } catch (error) {
                if (!silent) {
                    showStatus(
                        `Cloud backup failed: ${error instanceof Error ? error.message : error}`,
                        'error',
                    );
                }
                console.error('Cloud backfill error:', error);
            } finally {
                setProgress(null);
            }
        },
        [activeDeviceId, showStatus],
    );

    // Boot: adopt a shared dashboard link, load local data, resolve the cloud
    // sources — no grinder needed. Re-runs when sign-in state changes.
    useEffect(() => {
        if (sessionPending) return;
        adoptShareFragment();
        loadFromStore().then(() => refreshSources());
    }, [loadFromStore, refreshSources, sessionPending]);

    // Background sync whenever the resolved source changes (first resolution,
    // store picker, sign-in).
    const lastSyncedStore = useRef<string | null>(null);
    useEffect(() => {
        if (source && lastSyncedStore.current !== source.storeId) {
            lastSyncedStore.current = source.storeId;
            syncFromCloud({ silent: true });
        }
    }, [source, syncFromCloud]);

    // Claim the device's cloud store by possession, read-only: a grinder this
    // browser can read hands out its dashboard keys (docs/CLOUD_SYNC.md).
    // Owners see their stores via login instead, so this only fills a blank.
    const cloud = grinder.active?.snapshot?.cloud;
    useEffect(() => {
        if (cloud?.configured && cloud.view_key && !ownedStores.length && !getViewerSource()) {
            saveViewerSource({
                storeId: cloud.store_id,
                viewKey: cloud.view_key,
                baseUrl: cloud.server_url || '',
                linkedAt: Date.now(),
            });
            setViewer(getViewerSource());
        }
    }, [cloud, ownedStores.length]);

    const pullData = useCallback(async () => {
        if (!grinder.supported) {
            showStatus(
                'Web Bluetooth is not supported in this browser. Use Chrome or Edge.',
                'error',
            );
            return;
        }
        setBusy(true);
        const client = new GrinderDataClient();
        let currentFileIndex = 0;
        let totalFiles = 0;
        // Device status notifications arrive with every chunk; throttle the
        // progress updates so the main thread stays free for BLE events.
        let lastUpdate = 0;
        client.onFileProgress = (percent) => {
            const now = Date.now();
            if (now - lastUpdate < 100 || totalFiles === 0) return;
            lastUpdate = now;
            setProgress(((currentFileIndex + percent / 100) / totalFiles) * 100);
        };

        try {
            showStatus('Scanning for grinder...');
            await client.connect();
            showStatus('Connected. Requesting session list...');

            const { records: pulled, errors } = await client.pullAllSessions((p) => {
                if (p.stage === 'list-done') {
                    totalFiles = p.total ?? 0;
                    if (!totalFiles) setProgress(null);
                } else if (p.stage === 'file') {
                    currentFileIndex = p.index ?? 0;
                    setProgress(((p.index ?? 0) / (p.total ?? 1)) * 100);
                }
                if (p.message) showStatus(p.message);
            });

            // Capture the device health snapshot over the same connection.
            const health = await client.captureDeviceHealth((p) => {
                if (p.message) showStatus(p.message);
            });

            client.disconnect();
            setProgress(100);

            if (health?.system_info) ble.applySystemInfo(health.system_info);
            if (pulled.length) await saveSessions(pulled);
            if (health) await saveMeta('deviceReports', health);
            if (pulled.length || health) await saveMeta('lastPull', new Date().toISOString());

            if (errors.length) {
                showStatus(
                    `Pulled ${pulled.length} sessions; ${errors.length} failed: ` +
                        errors.map((e) => `#${e.sessionId} (${e.message})`).join(', '),
                    'warning',
                );
            } else if (pulled.length) {
                showStatus(`Pulled ${pulled.length} sessions from the grinder.`, 'success');
            } else {
                showStatus('The grinder has no stored sessions to pull.', 'warning');
            }

            await loadFromStore();

            // Automatic cloud backup: idempotent push of anything the store is
            // missing, plus a best-effort health observation.
            const activeSource = sourceRef.current;
            if (activeSource?.owned) {
                if (pulled.length) await backfillToCloud({ silent: true });
                if (health) {
                    pushSnapshotToCloud(activeSource, health, activeDeviceId()).catch(
                        (error: Error) => console.log('Cloud snapshot push failed:', error.message),
                    );
                }
            }
        } catch (error) {
            client.disconnect();
            showStatus(`Pull failed: ${error instanceof Error ? error.message : error}`, 'error');
            console.error('Analytics pull error:', error);
        } finally {
            setProgress(null);
            setBusy(false);
        }
    }, [activeDeviceId, backfillToCloud, grinder.supported, loadFromStore, showStatus]);

    const exportJson = useCallback(() => {
        if (!recordsRef.current.length) {
            showStatus('Nothing to export yet — pull or import data first.', 'warning');
            return;
        }
        const json = buildExportJson(recordsRef.current, deviceReports);
        const stamp = new Date().toISOString().slice(0, 10);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `grind-analytics-${stamp}.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
        showStatus(`Exported ${recordsRef.current.length} sessions.`, 'success');
    }, [deviceReports, showStatus]);

    const importJson = useCallback(
        async (file: File) => {
            try {
                const text = await file.text();
                const { records: imported, deviceReports: importedReports } = parseImportJson(text);
                await saveSessions(imported);
                if (importedReports) await saveMeta('deviceReports', importedReports);
                await saveMeta('lastPull', new Date().toISOString());
                await loadFromStore();
                showStatus(`Imported ${imported.length} sessions from ${file.name}.`, 'success');
            } catch (error) {
                showStatus(
                    `Import failed: ${error instanceof Error ? error.message : error}`,
                    'error',
                );
            }
        },
        [loadFromStore, showStatus],
    );

    const clearStoredData = useCallback(async () => {
        await clearAll();
        await loadFromStore();
        showStatus('Stored data cleared.', 'info');
    }, [loadFromStore, showStatus]);

    const snapshot = grinder.active?.snapshot;
    const value: AnalyticsState = {
        records,
        deviceReports,
        lastPull,
        status,
        progress,
        busy,
        loaded,
        source,
        ownedStores,
        signedIn,
        deviceSessions: snapshot?.sessions?.total_sessions as number | undefined,
        loggingOff:
            deviceReports?.system_info?.sessions?.logging_enabled === false ||
            snapshot?.sessions?.logging_enabled === false,
        showStatus,
        clearStatus,
        pullData,
        exportJson,
        importJson,
        clearStoredData,
        syncFromCloud,
        backfillToCloud,
        refreshSources,
    };

    return <AnalyticsContext value={value}>{children}</AnalyticsContext>;
}
