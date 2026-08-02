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
    isBlankAnnotation,
    loadAnnotations,
    loadBeansCache,
    loadMeta,
    loadSessions,
    parseImportJson,
    removeSession,
    saveAnnotations,
    saveBeansCache,
    saveMeta,
    saveSessions,
} from '@/lib/analytics/store';
import type { Annotation, Bean, DeviceReports, StoredRecord } from '@/lib/analytics/types';
import { authClient } from '@/lib/client/auth';
import * as ble from '@/lib/client/ble';
import {
    adoptShareFragment,
    type CloudSource,
    deleteCloudSession,
    fetchAnnotations,
    fetchBeans,
    getActiveStoreId,
    getViewerSource,
    listMyStores,
    type OwnedStore,
    pullFromCloud,
    pushAnnotations,
    pushSnapshotToCloud,
    pushToCloud,
    saveViewerSource,
    type ViewerSource,
} from '@/lib/client/cloud';
import { GrinderDataClient } from '@/lib/client/data-export';
import { useGrinder } from '@/lib/client/use-grinder';

interface AnalyticsState {
    records: StoredRecord[];
    annotations: Map<string, Annotation>;
    beans: Bean[];
    activeBeanId: string | null;
    deviceReports: DeviceReports | null;
    lastPull: string | null;
    status: StatusMessage | null;
    // A control the outcome requires, rendered beside the message instead of a
    // sentence naming the page it lives on.
    statusAction: ReactNode;
    progress: number | null;
    busy: boolean;
    loaded: boolean;
    source: CloudSource | null;
    ownedStores: OwnedStore[];
    signedIn: boolean;
    deviceSessions: number | undefined;
    loggingOff: boolean;
    showStatus: (text: string, kind?: StatusMessage['kind'], action?: ReactNode) => void;
    clearStatus: () => void;
    pullData: () => Promise<void>;
    exportJson: () => void;
    importJson: (file: File) => Promise<void>;
    clearStoredData: () => Promise<void>;
    saveAnnotation: (sha256: string, patch: Partial<Omit<Annotation, 'sha256'>>) => Promise<void>;
    deleteSession: (sha256: string) => Promise<void>;
    syncFromCloud: (options?: { silent?: boolean }) => Promise<void>;
    backfillToCloud: (options?: { silent?: boolean }) => Promise<void>;
    refreshSources: () => Promise<void>;
    refreshBeans: () => Promise<void>;
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
    const [annotations, setAnnotations] = useState<Map<string, Annotation>>(() => new Map());
    const [beans, setBeans] = useState<Bean[]>([]);
    const [activeBeanId, setActiveBeanId] = useState<string | null>(null);
    const [deviceReports, setDeviceReports] = useState<DeviceReports | null>(null);
    const [lastPull, setLastPull] = useState<string | null>(null);
    const [status, setStatus] = useState<StatusMessage | null>(null);
    const [statusAction, setStatusAction] = useState<ReactNode>(null);
    const [progress, setProgress] = useState<number | null>(null);
    const [busy, setBusy] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const [ownedStores, setOwnedStores] = useState<OwnedStore[]>([]);
    const [viewer, setViewer] = useState<ViewerSource | null>(null);
    const recordsRef = useRef<StoredRecord[]>([]);
    recordsRef.current = records;
    const annotationsRef = useRef<Map<string, Annotation>>(annotations);
    annotationsRef.current = annotations;

    const { data: session, isPending: sessionPending } = authClient.useSession();
    const signedIn = Boolean(session?.user);

    // The grinder this browser is talking to. Its id is what its cloud store
    // is bound to, so it also decides which store this dashboard shows.
    const systemDeviceId = grinder.active?.snapshot?.system?.device_id;
    const deviceId = typeof systemDeviceId === 'string' ? systemDeviceId : null;

    // Source resolution: owned stores (via login) win over a viewer link, and
    // within them an explicit pick wins over the connected grinder's own store.
    const source: CloudSource | null = useMemo(() => {
        if (ownedStores.length) {
            const activeId = getActiveStoreId();
            const store =
                ownedStores.find((s) => s.store_id === activeId) ??
                ownedStores.find((s) => s.device_id && s.device_id === deviceId) ??
                ownedStores[0];
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
    }, [ownedStores, viewer, deviceId]);
    const sourceRef = useRef<CloudSource | null>(source);
    sourceRef.current = source;

    // Annotations are local-first: whatever this browser holds is authoritative
    // until a store says otherwise, and then only per row, newest updated_at
    // winning. Blank entries still travel — they are how a cleared annotation
    // reaches other browsers.
    const reconcileAnnotations = useCallback(async (source: CloudSource) => {
        try {
            const remote = await fetchAnnotations(source);
            const local = new Map((await loadAnnotations()).map((e) => [e.sha256, e]));
            const incoming: Annotation[] = [];
            for (const entry of remote) {
                const mine = local.get(entry.sha256);
                if (!mine || Date.parse(entry.updated_at) > Date.parse(mine.updated_at)) {
                    incoming.push(entry);
                }
            }
            if (incoming.length) await saveAnnotations(incoming);

            if (source.owned) {
                const remoteAt = new Map(remote.map((e) => [e.sha256, Date.parse(e.updated_at)]));
                const outgoing = [...local.values()].filter((entry) => {
                    const seen = remoteAt.get(entry.sha256);
                    return seen === undefined
                        ? !isBlankAnnotation(entry)
                        : Date.parse(entry.updated_at) > seen;
                });
                if (outgoing.length) await pushAnnotations(source, outgoing);
            }
            setAnnotations(
                new Map((await loadAnnotations()).map((entry) => [entry.sha256, entry])),
            );
        } catch (error) {
            // A store without the annotations endpoint (or an offline browser)
            // must not break the session sync it rides along with.
            console.log('Annotation sync skipped:', (error as Error).message);
        }
    }, []);

    const showStatus = useCallback(
        (text: string, kind: StatusMessage['kind'] = 'info', action: ReactNode = null) => {
            setStatus({ text, kind });
            setStatusAction(action);
        },
        [],
    );
    const clearStatus = useCallback(() => {
        setStatus(null);
        setStatusAction(null);
    }, []);

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
        setAnnotations(new Map((await loadAnnotations()).map((entry) => [entry.sha256, entry])));
        const cachedBeans = await loadBeansCache();
        setBeans(cachedBeans.beans);
        setActiveBeanId(cachedBeans.activeBeanId);
        setDeviceReports(await loadMeta<DeviceReports>('deviceReports'));
        setLastPull(await loadMeta<string>('lastPull'));
        setLoaded(true);
        return stored;
    }, []);

    // Beans are server-authoritative; this refreshes the local read cache.
    // Best-effort like the annotation sync — an offline browser keeps its
    // cached copy and the page still renders.
    const syncBeans = useCallback(async (source: CloudSource) => {
        try {
            const list = await fetchBeans(source);
            await saveBeansCache(list.beans, list.active_bean_id);
            setBeans(list.beans);
            setActiveBeanId(list.active_bean_id);
        } catch (error) {
            console.log('Bean sync skipped:', (error as Error).message);
        }
    }, []);

    const refreshBeans = useCallback(async () => {
        const activeSource = sourceRef.current;
        if (activeSource) await syncBeans(activeSource);
    }, [syncBeans]);

    const syncFromCloud = useCallback(
        async ({ silent = false } = {}) => {
            const activeSource = sourceRef.current;
            if (!activeSource) return;
            try {
                if (!silent) showStatus('Checking your backup…');
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
                }
                await reconcileAnnotations(activeSource);
                await syncBeans(activeSource);
                if (fetched.length) await loadFromStore();
                if (errors.length) {
                    showStatus(
                        `${fetched.length} grinds added, ${errors.length} failed.`,
                        'warning',
                    );
                } else if (fetched.length) {
                    showStatus(
                        `Synced ${fetched.length} grinds · ${cloudTotal} backed up.`,
                        'success',
                    );
                } else if (!silent) {
                    showStatus('Already up to date.', 'success');
                }
            } catch (error) {
                if (!silent) {
                    showStatus(
                        `Sync failed: ${error instanceof Error ? error.message : error}`,
                        'error',
                    );
                }
                console.error('Cloud sync error:', error);
            } finally {
                setProgress(null);
            }
        },
        [loadFromStore, reconcileAnnotations, showStatus, syncBeans],
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
                    deviceId,
                    (p) => {
                        showStatus(p.message);
                        if (p.total) setProgress((p.index / p.total) * 100);
                    },
                );
                if (errors.length) {
                    showStatus(`${stored} uploaded, ${errors.length} failed.`, 'warning');
                } else if (stored) {
                    showStatus(`Backed up ${stored} grinds.`, 'success');
                } else if (!silent) {
                    showStatus('Everything is backed up.', 'success');
                }
            } catch (error) {
                if (!silent) {
                    showStatus(
                        `Backup failed: ${error instanceof Error ? error.message : error}`,
                        'error',
                    );
                }
                console.error('Cloud backfill error:', error);
            } finally {
                setProgress(null);
            }
        },
        [deviceId, showStatus],
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
            showStatus('Web Bluetooth needs Chrome or Edge.', 'error');
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
            showStatus('Connecting…');
            await client.connect();
            showStatus('Listing grinds…');

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
                    `Pulled ${pulled.length} grinds; ${errors.length} failed: ` +
                        errors.map((e) => `#${e.sessionId} (${e.message})`).join(', '),
                    'warning',
                );
            } else if (pulled.length) {
                showStatus(`Pulled ${pulled.length} grinds.`, 'success');
            } else {
                showStatus('No grinds on the grinder.', 'warning');
            }

            await loadFromStore();

            // Automatic cloud backup: idempotent push of anything the store is
            // missing, plus a best-effort health observation.
            const activeSource = sourceRef.current;
            if (activeSource?.owned) {
                if (pulled.length) await backfillToCloud({ silent: true });
                if (health) {
                    pushSnapshotToCloud(activeSource, health, deviceId).catch((error: Error) =>
                        console.log('Cloud snapshot push failed:', error.message),
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
    }, [backfillToCloud, deviceId, grinder.supported, loadFromStore, showStatus]);

    const exportJson = useCallback(() => {
        if (!recordsRef.current.length) {
            showStatus('Nothing to export yet.', 'warning');
            return;
        }
        const json = buildExportJson(recordsRef.current, deviceReports, [
            ...annotationsRef.current.values(),
        ]);
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
        showStatus(`Exported ${recordsRef.current.length} grinds.`, 'success');
    }, [deviceReports, showStatus]);

    const importJson = useCallback(
        async (file: File) => {
            try {
                const text = await file.text();
                const {
                    records: imported,
                    deviceReports: importedReports,
                    annotations: importedAnnotations,
                } = parseImportJson(text);
                await saveSessions(imported);
                if (importedAnnotations.length) await saveAnnotations(importedAnnotations);
                if (importedReports) await saveMeta('deviceReports', importedReports);
                await saveMeta('lastPull', new Date().toISOString());
                await loadFromStore();
                showStatus(`Imported ${imported.length} grinds.`, 'success');
            } catch (error) {
                showStatus(
                    `Import failed: ${error instanceof Error ? error.message : error}`,
                    'error',
                );
            }
        },
        [loadFromStore, showStatus],
    );

    const saveAnnotation = useCallback(
        async (sha256: string, patch: Partial<Omit<Annotation, 'sha256'>>) => {
            const existing = annotationsRef.current.get(sha256);
            const entry: Annotation = {
                sha256,
                bean: null,
                roast_date: null,
                grind_setting: null,
                note: null,
                tags: [],
                ...existing,
                ...patch,
                updated_at: new Date().toISOString(),
            };
            await saveAnnotations([entry]);
            setAnnotations((current) => new Map(current).set(sha256, entry));
            const activeSource = sourceRef.current;
            if (activeSource?.owned) {
                pushAnnotations(activeSource, [entry]).catch((error: Error) =>
                    console.log('Annotation push failed:', error.message),
                );
            }
        },
        [],
    );

    // Local removal always happens; the cloud copy only when this account owns
    // the store, where the server also writes a tombstone so the grinder can't
    // upload it again on the next sync.
    const deleteSession = useCallback(
        async (sha256: string) => {
            const activeSource = sourceRef.current;
            if (activeSource?.owned) {
                try {
                    await deleteCloudSession(activeSource, sha256);
                } catch (error) {
                    showStatus(
                        `Deleted here, but not from your backup: ${
                            error instanceof Error ? error.message : error
                        }`,
                        'warning',
                    );
                }
            }
            await removeSession(sha256);
            await loadFromStore();
        },
        [loadFromStore, showStatus],
    );

    const clearStoredData = useCallback(async () => {
        await clearAll();
        await loadFromStore();
        showStatus('Local grinds deleted.', 'info');
    }, [loadFromStore, showStatus]);

    const snapshot = grinder.active?.snapshot;
    const value: AnalyticsState = {
        records,
        annotations,
        beans,
        activeBeanId,
        deviceReports,
        lastPull,
        status,
        statusAction,
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
        saveAnnotation,
        deleteSession,
        syncFromCloud,
        backfillToCloud,
        refreshSources,
        refreshBeans,
    };

    return <AnalyticsContext value={value}>{children}</AnalyticsContext>;
}
