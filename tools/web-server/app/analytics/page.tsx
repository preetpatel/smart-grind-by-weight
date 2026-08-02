'use client';

// Analytics dashboard: pull data over BLE or sync from the cloud store,
// persist locally (IndexedDB keyed by content hash), and render the session
// browser + analysis views. React port of the flasher's analytics/app.js.
import { useCallback, useEffect, useRef, useState } from 'react';
import { CloudBar } from '@/components/analytics/cloud-bar';
import { HealthView } from '@/components/analytics/health-view';
import { Hero } from '@/components/analytics/hero';
import { MultiView } from '@/components/analytics/multi-view';
import { OverallTab } from '@/components/analytics/overall-tab';
import { SessionsTable } from '@/components/analytics/sessions-table';
import {
    ControllerTab,
    PredictiveTab,
    PulseTab,
    VibrationTab,
} from '@/components/analytics/single-views';
import { CompareView, TrendsView } from '@/components/analytics/trends-views';
import { ProgressBar, StatusBox, type StatusMessage, SubTabs } from '@/components/ui';
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
import * as ble from '@/lib/client/ble';
import {
    adoptShareFragment,
    type CloudConfig,
    getCloudConfig,
    pullFromCloud,
    pushSnapshotToCloud,
    pushToCloud,
    saveCloudConfig,
} from '@/lib/client/cloud';
import { GrinderDataClient } from '@/lib/client/data-export';
import { useGrinder } from '@/lib/client/use-grinder';

const ANALYSIS_MODES = [
    { key: 'single', label: 'Single Session' },
    { key: 'compare', label: 'Compare' },
    { key: 'multi', label: 'Multi-Session' },
    { key: 'trends', label: 'Trends' },
    { key: 'health', label: 'Device Health' },
] as const;

const DETAIL_TABS = [
    { key: 'overall', label: 'Overall' },
    { key: 'predictive', label: 'Predictive Phase' },
    { key: 'pulse', label: 'Pulse Phase' },
    { key: 'vibration', label: 'Vibration' },
    { key: 'controller', label: 'Controller' },
] as const;

type AnalysisMode = (typeof ANALYSIS_MODES)[number]['key'];
type DetailTab = (typeof DETAIL_TABS)[number]['key'];

const SMOOTHING_OPTIONS: Array<[string, number]> = [
    ['None', 0],
    ['100 ms', 100],
    ['500 ms', 500],
    ['1000 ms', 1000],
    ['1500 ms', 1500],
];

export default function AnalyticsPage() {
    const grinder = useGrinder();
    const [records, setRecords] = useState<StoredRecord[]>([]);
    const [deviceReports, setDeviceReports] = useState<DeviceReports | null>(null);
    const [lastPull, setLastPull] = useState<string | null>(null);
    const [status, setStatus] = useState<StatusMessage | null>(null);
    const [progress, setProgress] = useState<number | null>(null);
    const [busy, setBusy] = useState(false);
    const [selectedSha, setSelectedSha] = useState<string | null>(null);
    const [mode, setMode] = useState<AnalysisMode>('single');
    const [detailTab, setDetailTab] = useState<DetailTab>('overall');
    const [includeTaring, setIncludeTaring] = useState(false);
    const [smoothingMs, setSmoothingMs] = useState(500);
    const [cloudConfig, setCloudConfig] = useState<CloudConfig | null>(null);
    const importInput = useRef<HTMLInputElement>(null);
    const recordsRef = useRef<StoredRecord[]>([]);
    recordsRef.current = records;

    const showStatus = useCallback(
        (text: string, kind: StatusMessage['kind'] = 'info') => setStatus({ text, kind }),
        [],
    );

    const loadFromStore = useCallback(async () => {
        const stored = await loadSessions();
        setRecords(stored);
        setDeviceReports(await loadMeta<DeviceReports>('deviceReports'));
        setLastPull(await loadMeta<string>('lastPull'));
        // Open on the newest session so the overview chart is visible without
        // an extra click; keep a still-valid selection.
        setSelectedSha((prev) =>
            prev && stored.some((r) => r.sha256 === prev)
                ? prev
                : (stored[stored.length - 1]?.sha256 ?? null),
        );
        return stored;
    }, []);

    const activeDeviceId = useCallback((): string | null => {
        const id = grinder.active?.snapshot?.system?.device_id;
        return typeof id === 'string' ? id : null;
    }, [grinder.active]);

    const syncFromCloud = useCallback(
        async ({ silent = false } = {}) => {
            const config = getCloudConfig();
            if (!config) return;
            try {
                if (!silent) showStatus('Checking the cloud store...');
                const known = new Set(recordsRef.current.map((r) => r.sha256));
                const {
                    records: fetched,
                    errors,
                    cloudTotal,
                } = await pullFromCloud(config, known, (p) => {
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

    // Push any locally-held sessions the store is missing (verbatim raw
    // bytes; the server dedups by content hash, so always safe to re-run).
    const backfillToCloud = useCallback(
        async ({ silent = false } = {}) => {
            const config = getCloudConfig();
            if (!config?.uploadKey) return;
            try {
                const { stored, errors } = await pushToCloud(
                    config,
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

    // Boot: adopt a shared dashboard link, load local data, then refresh from
    // the cloud in the background — no grinder needed.
    useEffect(() => {
        const adopted = adoptShareFragment();
        setCloudConfig(getCloudConfig());
        loadFromStore().then(() => {
            if (getCloudConfig()) {
                syncFromCloud({ silent: !adopted });
            }
        });
    }, [loadFromStore, syncFromCloud]);

    // Claim the device's cloud store by possession: a grinder this browser
    // can read hands out its read-only dashboard keys (docs/CLOUD_SYNC.md).
    const cloud = grinder.active?.snapshot?.cloud;
    useEffect(() => {
        if (cloud?.configured && cloud.view_key && !getCloudConfig()) {
            saveCloudConfig({
                storeId: cloud.store_id,
                viewKey: cloud.view_key,
                baseUrl: cloud.server_url || '',
                linkedAt: Date.now(),
            });
            setCloudConfig(getCloudConfig());
            syncFromCloud({ silent: true });
        }
    }, [cloud, syncFromCloud]);

    const pullData = async () => {
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

            // Automatic cloud backup: idempotent push of anything the store
            // is missing, plus a best-effort health observation.
            const config = getCloudConfig();
            if (config?.uploadKey) {
                if (pulled.length) await backfillToCloud({ silent: true });
                if (health) {
                    pushSnapshotToCloud(config, health, activeDeviceId()).catch((error: Error) =>
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
    };

    const exportJson = () => {
        if (!records.length) {
            showStatus('Nothing to export yet — pull or import data first.', 'warning');
            return;
        }
        const json = buildExportJson(records, deviceReports);
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
        showStatus(`Exported ${records.length} sessions.`, 'success');
    };

    const importJson = async (file: File) => {
        try {
            const text = await file.text();
            const { records: imported, deviceReports: importedReports } = parseImportJson(text);
            await saveSessions(imported);
            if (importedReports) await saveMeta('deviceReports', importedReports);
            await saveMeta('lastPull', new Date().toISOString());
            await loadFromStore();
            showStatus(`Imported ${imported.length} sessions from ${file.name}.`, 'success');
        } catch (error) {
            showStatus(`Import failed: ${error instanceof Error ? error.message : error}`, 'error');
        }
    };

    const clearStoredData = async () => {
        if (
            !window.confirm(
                'Delete all grind data stored in this browser? This does not affect the grinder itself.',
            )
        ) {
            return;
        }
        await clearAll();
        setSelectedSha(null);
        await loadFromStore();
        showStatus('Stored data cleared.', 'info');
    };

    const snapshot = grinder.active?.snapshot;
    const loggingOff =
        deviceReports?.system_info?.sessions?.logging_enabled === false ||
        snapshot?.sessions?.logging_enabled === false;
    const deviceSessions = snapshot?.sessions?.total_sessions;
    const totalEvents = records.reduce((sum, r) => sum + r.events.length, 0);
    const totalMeasurements = records.reduce((sum, r) => sum + r.measurements.length, 0);
    const selectedRecord = records.find((r) => r.sha256 === selectedSha) ?? null;

    return (
        <div>
            <div className="analytics-toolbar">
                <button
                    type="button"
                    className="btn btn-accent"
                    disabled={busy || !grinder.supported}
                    onClick={pullData}
                >
                    Connect &amp; Pull Data
                </button>
                <div className="spacer" />
                <button type="button" className="btn-ghost" onClick={exportJson}>
                    Export JSON
                </button>
                <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => importInput.current?.click()}
                >
                    Import JSON
                </button>
                <button type="button" className="btn-ghost danger" onClick={clearStoredData}>
                    Clear Data
                </button>
            </div>
            <input
                ref={importInput}
                type="file"
                accept=".json,application/json"
                style={{ display: 'none' }}
                onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) importJson(file);
                    e.target.value = '';
                }}
            />

            <CloudBar
                config={cloudConfig}
                onConfigChange={() => setCloudConfig(getCloudConfig())}
                onSync={() => syncFromCloud()}
                onBackfill={() => backfillToCloud()}
                onStatus={(text, kind) => showStatus(text, kind)}
                hasRecords={records.length > 0}
            />

            <StatusBox status={status} />
            <ProgressBar percent={progress} />

            {loggingOff && (
                <div className="status warning">
                    Grind logging is OFF on the device — grinds are not being recorded. Enable it
                    under Menu → Logs &amp; Data on the grinder.
                </div>
            )}

            {records.length === 0 ? (
                <div className="status info">
                    {deviceSessions
                        ? `No grind data stored in this browser yet — your grinder has ${String(deviceSessions)} sessions ready to pull.`
                        : 'No grind data stored yet. Pull data from the grinder, sync from your cloud store, or import a JSON export.'}
                </div>
            ) : (
                <>
                    <Hero records={records} />
                    <div className="store-line">
                        {records.length} sessions · {totalEvents.toLocaleString()} events ·{' '}
                        {totalMeasurements.toLocaleString()} measurements stored in this browser
                        {lastPull ? ` · last pull ${new Date(lastPull).toLocaleString()}` : ''}
                        {deviceSessions !== undefined
                            ? ` · grinder holds ${String(deviceSessions)} sessions`
                            : ''}
                    </div>
                </>
            )}

            {(records.length > 0 || deviceReports) && (
                <SubTabs tabs={ANALYSIS_MODES} active={mode} onChange={setMode} />
            )}

            {mode === 'health' && <HealthView deviceReports={deviceReports} />}
            {mode === 'multi' && records.length > 0 && <MultiView records={records} />}
            {mode === 'trends' && records.length > 0 && (
                <TrendsView records={records} deviceReports={deviceReports} />
            )}
            {mode === 'compare' && records.length > 0 && <CompareView records={records} />}
            {mode !== 'health' && mode !== 'single' && records.length === 0 && (
                <div className="status info">No grind sessions stored yet.</div>
            )}

            {mode === 'single' && records.length > 0 && (
                <>
                    <SessionsTable
                        records={records}
                        selectedSha={selectedSha}
                        onSelect={setSelectedSha}
                    />
                    {selectedRecord && (
                        <div>
                            <h3>Session #{selectedRecord.session_id} — Analysis</h3>
                            <div className="controls-row">
                                <label className="control">
                                    <input
                                        type="checkbox"
                                        checked={includeTaring}
                                        onChange={(e) => setIncludeTaring(e.target.checked)}
                                    />{' '}
                                    Include taring
                                </label>
                                <label className="control">
                                    Flow smoothing{' '}
                                    <select
                                        value={smoothingMs}
                                        onChange={(e) => setSmoothingMs(Number(e.target.value))}
                                    >
                                        {SMOOTHING_OPTIONS.map(([label, value]) => (
                                            <option key={value} value={value}>
                                                {label}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                            </div>
                            <SubTabs
                                tabs={DETAIL_TABS}
                                active={detailTab}
                                onChange={setDetailTab}
                            />
                            {detailTab === 'overall' && (
                                <OverallTab
                                    record={selectedRecord}
                                    includeTaring={includeTaring}
                                    smoothingMs={smoothingMs}
                                />
                            )}
                            {detailTab === 'predictive' && (
                                <PredictiveTab
                                    record={selectedRecord}
                                    includeTaring={includeTaring}
                                    smoothingMs={smoothingMs}
                                />
                            )}
                            {detailTab === 'pulse' && (
                                <PulseTab
                                    record={selectedRecord}
                                    includeTaring={includeTaring}
                                    smoothingMs={smoothingMs}
                                />
                            )}
                            {detailTab === 'vibration' && (
                                <VibrationTab
                                    record={selectedRecord}
                                    includeTaring={includeTaring}
                                />
                            )}
                            {detailTab === 'controller' && (
                                <ControllerTab
                                    record={selectedRecord}
                                    includeTaring={includeTaring}
                                />
                            )}
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
