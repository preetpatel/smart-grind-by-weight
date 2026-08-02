// Shared BLE session + known-grinder registry (TypeScript port of the
// flasher's grinder-session.js).
//
// One GATT connection serves every flow in the app (update, WiFi, cloud,
// diagnostics, analytics): the browser chooser appears once and later
// actions reuse the link. The connection is released after a short idle
// window so the grinder stays free for other centrals (the Python tool)
// and for its own WiFi sync windows.
//
// Known grinders persist in localStorage keyed by the stable per-origin
// Web Bluetooth device id. On Chrome 117+ (persistent device permissions,
// navigator.bluetooth.getDevices) a known grinder reconnects without the
// chooser, which powers the silent snapshot refresh on page load.
//
// React components consume this through useSyncExternalStore via the
// subscribe/getRegistryVersion pair (see components/device-strip.tsx).

import { normalizeDeviceId } from '@/lib/device-id';

export const DEVICE_NAME = 'GrindByWeight';

// UUIDs mirror src/config/bluetooth.h.
export const UUIDS = {
    OTA_SERVICE: '12345678-1234-1234-1234-123456789abc',
    OTA_DATA: '87654321-4321-4321-4321-cba987654321',
    OTA_CONTROL: '11111111-2222-3333-4444-555555555555',
    OTA_STATUS: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    OTA_BUILD_NUMBER: '66666666-7777-8888-9999-000000000000',
    DEBUG_SERVICE: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
    DEBUG_TX: '6e400003-b5a3-f393-e0a9-e50e24dcca9e',
    DATA_SERVICE: '22334455-6677-8899-aabb-ccddeeffffaa',
    DATA_CONTROL: '33445566-7788-99aa-bbcc-ddeeffaabbcc',
    DATA_TRANSFER: '44556677-8899-aabb-ccdd-eeffaabbccdd',
    DATA_STATUS: '55667788-99aa-bbcc-ddee-ffaabbccddee',
    SYSINFO_SERVICE: '77889900-aabb-ccdd-eeff-112233445566',
    SYSINFO_SYSTEM: '88990011-bbcc-ddee-ff11-223344556677',
    SYSINFO_PERFORMANCE: '99001122-ccdd-eeff-1122-334455667788',
    SYSINFO_HARDWARE: '00112233-ddee-ff11-2233-445566778899',
    SYSINFO_SESSIONS: '11223344-eeff-1122-3344-556677889900',
    SYSINFO_DIAGNOSTICS: '22334455-ff00-1111-2222-334455667788',
    SYSINFO_TIMESYNC: '33445566-ff00-1111-2222-334455667788',
    SYSINFO_WIFI_CONFIG: '44556677-ff00-1111-2222-334455667788',
    SYSINFO_WIFI_STATUS: '556677ee-ff00-1111-2222-334455667788',
    SYSINFO_CLOUD_CONFIG: '66778899-ff00-1111-2222-334455667788',
    SYSINFO_CLOUD_STATUS: '778899aa-ff00-1111-2222-334455667788',
    SYSINFO_BEAN_CONFIG: '8899aabb-ff00-1111-2222-334455667788',
    SYSINFO_BEAN_STATUS: '99aabbcc-ff00-1111-2222-334455667788',
} as const;

// Requested once at pairing time so the permission grant covers every flow.
const ALL_SERVICES: string[] = [
    UUIDS.OTA_SERVICE,
    UUIDS.DEBUG_SERVICE,
    UUIDS.DATA_SERVICE,
    UUIDS.SYSINFO_SERVICE,
];

export interface WifiStatusJson {
    configured: boolean;
    enabled: boolean;
    ssid: string;
    state: string;
    last_result: string;
    tz_name: string;
    tz_rule_set: boolean;
    time_synced: boolean;
    last_sync_epoch: number;
}

export interface CloudStatusJson {
    configured: boolean;
    enabled: boolean;
    state: string;
    last_result: string;
    server_url: string;
    store_id: string;
    view_key: string;
    last_success_epoch: number;
    last_run_uploaded: number;
    unsynced: boolean;
}

// A "snapshot" is the set of lightweight single-read characteristics cached
// per grinder so the UI can be device-aware while offline.
export interface GrinderSnapshot {
    build?: string;
    system?: Record<string, unknown>;
    sessions?: Record<string, unknown>;
    wifi?: WifiStatusJson;
    cloud?: CloudStatusJson;
    fetchedAt?: number;
}

export interface RegistryEntry {
    label: string;
    snapshot: GrinderSnapshot | null;
    lastSeen?: number;
}

export interface ActiveGrinder extends RegistryEntry {
    id: string;
}

const REGISTRY_KEY = 'grinderRegistry';
const ACTIVE_KEY = 'activeGrinderId';
const SEEN_KEY = 'grinderSeen';
const IDLE_RELEASE_MS = 30000;
const SILENT_CONNECT_TIMEOUT_MS = 10000;

let holdCount = 0; // >0 while a long operation owns the link (see hold())
let device: BluetoothDevice | null = null;
let server: BluetoothRemoteGATTServer | null = null;
let serviceCache = new Map<string, BluetoothRemoteGATTService>();
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let connectPromise: Promise<BluetoothRemoteGATTServer> | null = null;
const attachedDevices = new WeakSet<BluetoothDevice>();
const listeners = new Set<() => void>();

// Monotonic version for useSyncExternalStore snapshots: bumped on every
// registry/connection change so React re-reads derived state.
let version = 0;

// ---- registry ------------------------------------------------------------

function loadRegistry(): Record<string, RegistryEntry> {
    try {
        return (
            (JSON.parse(localStorage.getItem(REGISTRY_KEY) ?? '') as Record<
                string,
                RegistryEntry
            >) || {}
        );
    } catch {
        return {};
    }
}

function saveRegistry(registry: Record<string, RegistryEntry>): void {
    try {
        localStorage.setItem(REGISTRY_KEY, JSON.stringify(registry));
    } catch {
        /* private mode */
    }
}

function getActiveId(): string | null {
    try {
        return localStorage.getItem(ACTIVE_KEY);
    } catch {
        return null;
    }
}

function setActiveId(id: string | null): void {
    try {
        if (id) localStorage.setItem(ACTIVE_KEY, id);
        else localStorage.removeItem(ACTIVE_KEY);
    } catch {
        /* private mode */
    }
}

function upsertRegistry(dev: BluetoothDevice): void {
    const registry = loadRegistry();
    if (!registry[dev.id]) {
        const count = Object.keys(registry).length;
        registry[dev.id] = {
            label:
                count === 0 ? dev.name || DEVICE_NAME : `${dev.name || DEVICE_NAME} ${count + 1}`,
            snapshot: null,
        };
    }
    const entry = registry[dev.id];
    if (entry) entry.lastSeen = Date.now();
    saveRegistry(registry);
    setActiveId(dev.id);
    try {
        localStorage.setItem(SEEN_KEY, '1');
    } catch {
        /* private mode */
    }
}

export function getActive(): ActiveGrinder | null {
    if (typeof window === 'undefined') return null;
    const registry = loadRegistry();
    let id = getActiveId();
    if (!id || !registry[id]) {
        id = Object.keys(registry)[0] ?? null;
        if (id) setActiveId(id);
    }
    const entry = id ? registry[id] : undefined;
    return id && entry ? { id, ...entry } : null;
}

export function listGrinders(): ActiveGrinder[] {
    if (typeof window === 'undefined') return [];
    return Object.entries(loadRegistry()).map(([id, entry]) => ({ id, ...entry }));
}

export function setActive(id: string): void {
    if (id === getActiveId()) return;
    disconnectNow();
    device = null;
    setActiveId(id);
    notify();
}

export function rename(id: string, label: string): void {
    const registry = loadRegistry();
    const entry = registry[id];
    if (!entry || !label.trim()) return;
    entry.label = label.trim();
    saveRegistry(registry);
    notify();
}

// The registry is keyed by the browser's Web Bluetooth device id, which is
// meaningless anywhere else; a cloud store is keyed by the grinder's factory
// MAC, which arrives in the snapshot. This is the join between the two, so
// renaming a backup can rename the grinder it belongs to. Returns whether a
// grinder matched — a browser that has never paired this one has nothing to
// rename, which is not an error.
export function renameByDeviceId(deviceId: string, label: string): boolean {
    const wanted = normalizeDeviceId(deviceId);
    if (!wanted || !label.trim()) return false;
    const registry = loadRegistry();
    const found = Object.entries(registry).find(
        ([, entry]) => normalizeDeviceId(entry.snapshot?.system?.device_id) === wanted,
    );
    if (!found) return false;
    found[1].label = label.trim();
    saveRegistry(registry);
    notify();
    return true;
}

export function forget(id: string): void {
    const registry = loadRegistry();
    delete registry[id];
    saveRegistry(registry);
    if (getActiveId() === id) {
        disconnectNow();
        device = null;
        setActiveId(Object.keys(registry)[0] ?? null);
    }
    notify();
}

export function hasSeenGrinder(): boolean {
    try {
        if (localStorage.getItem(SEEN_KEY)) return true;
    } catch {
        /* private mode */
    }
    return !!getActive();
}

// ---- change notifications ------------------------------------------------

export function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function getRegistryVersion(): number {
    return version;
}

function notify(): void {
    version++;
    for (const listener of listeners) {
        try {
            listener();
        } catch (error) {
            console.error('GrinderSession listener error:', error);
        }
    }
}

// ---- connection lifecycle ------------------------------------------------

export function isSupported(): boolean {
    return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
}

export function isConnected(): boolean {
    return !!server?.connected;
}

export function currentDevice(): BluetoothDevice | null {
    return device;
}

function attach(dev: BluetoothDevice): void {
    device = dev;
    if (!attachedDevices.has(dev)) {
        attachedDevices.add(dev);
        dev.addEventListener('gattserverdisconnected', () => {
            serviceCache = new Map();
            if (device === dev) notify();
        });
    }
}

// Chrome 117+ remembers permitted devices across visits; reconnecting to one
// skips the chooser entirely. Older browsers return null and callers fall
// back to the interactive path.
async function findKnownDevice(): Promise<BluetoothDevice | null> {
    if (!navigator.bluetooth || typeof navigator.bluetooth.getDevices !== 'function') return null;
    const activeId = getActive()?.id;
    if (!activeId) return null;
    try {
        const devices = await navigator.bluetooth.getDevices();
        return devices.find((d) => d.id === activeId) ?? null;
    } catch {
        return null;
    }
}

// gatt.connect() on a permitted-but-absent device scans indefinitely; silent
// attempts are raced against a timeout and cancelled.
async function gattConnect(
    dev: BluetoothDevice,
    timeoutMs: number,
): Promise<BluetoothRemoteGATTServer> {
    const gatt = dev.gatt;
    if (!gatt) throw new Error('Device has no GATT server');
    if (!timeoutMs) return gatt.connect();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            gatt.connect(),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    gatt.disconnect();
                    reject(new Error('Grinder not in range (silent connect timed out)'));
                }, timeoutMs);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

// Every BLE client writes the wall clock on connect (see time_sync.h);
// best-effort so older firmware just skips it.
async function syncClock(): Promise<void> {
    try {
        const service = await getService(UUIDS.SYSINFO_SERVICE);
        const characteristic = await service.getCharacteristic(UUIDS.SYSINFO_TIMESYNC);
        const payload = new ArrayBuffer(6);
        const view = new DataView(payload);
        view.setUint32(0, Math.floor(Date.now() / 1000), true);
        view.setInt16(4, -new Date().getTimezoneOffset(), true);
        await characteristic.writeValue(payload);
    } catch (error) {
        console.log('Clock sync unavailable:', error instanceof Error ? error.message : error);
    }
}

export async function connect({ interactive = true } = {}): Promise<BluetoothRemoteGATTServer> {
    cancelIdle();
    if (server?.connected) return server;
    if (connectPromise) return connectPromise;

    connectPromise = (async () => {
        let dev = device;
        let silent = false;
        if (!dev) {
            dev = await findKnownDevice();
            silent = !!dev;
        }
        if (!dev) {
            if (!interactive) throw new Error('No known grinder available for a silent connect');
            dev = await navigator.bluetooth.requestDevice({
                filters: [{ name: DEVICE_NAME }],
                optionalServices: ALL_SERVICES,
            });
        }
        attach(dev);
        server = await gattConnect(dev, silent || !interactive ? SILENT_CONNECT_TIMEOUT_MS : 0);
        serviceCache = new Map();
        upsertRegistry(dev);
        await syncClock();
        notify();
        return server;
    })();

    try {
        return await connectPromise;
    } finally {
        connectPromise = null;
    }
}

export async function getService(uuid: string): Promise<BluetoothRemoteGATTService> {
    if (!server?.connected) throw new Error('Not connected to a grinder');
    let service = serviceCache.get(uuid);
    if (!service) {
        service = await server.getPrimaryService(uuid);
        serviceCache.set(uuid, service);
    }
    return service;
}

// Keeps the link warm briefly for follow-up actions, then lets go so the
// grinder is reachable by other tools and its WiFi sync windows.
export function release(): void {
    if (holdCount > 0) return; // a long operation owns the link
    cancelIdle();
    idleTimer = setTimeout(() => disconnectNow(), IDLE_RELEASE_MS);
}

// Operations that run far longer than the idle window - firmware upload,
// grind-data export, the diagnostics stream - must hold the link for their
// duration. Without this, ANY concurrent flow calling release() (e.g. the
// device strip's background snapshot refresh) arms a 30s timer that
// disconnects mid-transfer. Always pair with releaseHold() in a finally
// block; holds nest.
export function hold(): void {
    holdCount++;
    cancelIdle();
}

export function releaseHold(): void {
    if (holdCount > 0) holdCount--;
    if (holdCount === 0) release();
}

function cancelIdle(): void {
    if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }
}

export function disconnectNow(): void {
    cancelIdle();
    holdCount = 0; // link is gone; never leave a stuck hold behind
    if (device?.gatt?.connected) device.gatt.disconnect();
    server = null;
    serviceCache = new Map();
}

// ---- snapshot ------------------------------------------------------------

async function readJson<T>(serviceUuid: string, charUuid: string): Promise<T> {
    const service = await getService(serviceUuid);
    const characteristic = await service.getCharacteristic(charUuid);
    const value = await characteristic.readValue();
    return JSON.parse(new TextDecoder().decode(value)) as T;
}

function patchSnapshot(id: string, patch: Partial<GrinderSnapshot>): void {
    const registry = loadRegistry();
    const entry = registry[id];
    if (!entry) return;
    entry.snapshot = { ...(entry.snapshot ?? {}), ...patch, fetchedAt: Date.now() };
    entry.lastSeen = Date.now();
    saveRegistry(registry);
    notify();
}

// Reads the cheap characteristics over the current connection. Each read is
// best-effort so one missing characteristic (older firmware) doesn't lose
// the rest.
async function readSnapshotConnected(): Promise<GrinderSnapshot> {
    const snapshot: GrinderSnapshot = {};
    try {
        const otaService = await getService(UUIDS.OTA_SERVICE);
        const buildChar = await otaService.getCharacteristic(UUIDS.OTA_BUILD_NUMBER);
        snapshot.build = new TextDecoder().decode(await buildChar.readValue()).trim();
    } catch {
        /* keep going */
    }
    try {
        snapshot.system = await readJson(UUIDS.SYSINFO_SERVICE, UUIDS.SYSINFO_SYSTEM);
    } catch {
        /* keep going */
    }
    try {
        snapshot.sessions = await readJson(UUIDS.SYSINFO_SERVICE, UUIDS.SYSINFO_SESSIONS);
    } catch {
        /* keep going */
    }
    try {
        snapshot.wifi = await readJson(UUIDS.SYSINFO_SERVICE, UUIDS.SYSINFO_WIFI_STATUS);
    } catch {
        /* keep going */
    }
    try {
        snapshot.cloud = await readJson(UUIDS.SYSINFO_SERVICE, UUIDS.SYSINFO_CLOUD_STATUS);
    } catch {
        /* older firmware */
    }
    return snapshot;
}

export async function refreshSnapshot({ interactive = false } = {}): Promise<GrinderSnapshot> {
    await connect({ interactive });
    const snapshot = await readSnapshotConnected();
    if (device) patchSnapshot(device.id, snapshot);
    release();
    return snapshot;
}

// Pairs a grinder explicitly (always shows the chooser), makes it the active
// one, and takes its first snapshot.
export async function addGrinder(): Promise<GrinderSnapshot> {
    disconnectNow();
    device = null;
    const dev = await navigator.bluetooth.requestDevice({
        filters: [{ name: DEVICE_NAME }],
        optionalServices: ALL_SERVICES,
    });
    attach(dev);
    server = await gattConnect(dev, 0);
    serviceCache = new Map();
    upsertRegistry(dev);
    await syncClock();
    notify();
    const snapshot = await readSnapshotConnected();
    patchSnapshot(dev.id, snapshot);
    release();
    return snapshot;
}

// Lets flows that already read fresh device state (WiFi status readback, the
// analytics health capture) fold it into the cached snapshot.
export function applyPatch(patch: Partial<GrinderSnapshot>): void {
    const active = getActive();
    if (active) patchSnapshot(active.id, patch);
}

export function applySystemInfo(
    systemInfo: {
        system?: Record<string, unknown> | null;
        sessions?: Record<string, unknown> | null;
    } | null,
): void {
    if (!systemInfo) return;
    const patch: Partial<GrinderSnapshot> = {};
    if (systemInfo.system) patch.system = systemInfo.system;
    if (systemInfo.sessions) patch.sessions = systemInfo.sessions;
    if (Object.keys(patch).length) applyPatch(patch);
}

if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => disconnectNow());
}
