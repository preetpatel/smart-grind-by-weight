// Shared BLE session + known-grinder registry for the web flasher.
//
// One GATT connection serves every flow on the page (update, WiFi,
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
// A "snapshot" is the set of lightweight single-read characteristics —
// build number, system info JSON, sessions/lifetime JSON, WiFi status
// JSON — cached per grinder so the UI can be device-aware while offline.
(function () {
    'use strict';

    const DEVICE_NAME = 'GrindByWeight';

    const UUIDS = {
        OTA_SERVICE: '12345678-1234-1234-1234-123456789abc',
        OTA_BUILD_NUMBER: '66666666-7777-8888-9999-000000000000',
        DEBUG_SERVICE: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
        DATA_SERVICE: '22334455-6677-8899-aabb-ccddeeffffaa',
        SYSINFO_SERVICE: '77889900-aabb-ccdd-eeff-112233445566',
        SYSINFO_SYSTEM: '88990011-bbcc-ddee-ff11-223344556677',
        SYSINFO_SESSIONS: '11223344-eeff-1122-3344-556677889900',
        SYSINFO_TIMESYNC: '33445566-ff00-1111-2222-334455667788',
        SYSINFO_WIFI_STATUS: '556677ee-ff00-1111-2222-334455667788',
    };

    // Requested once at pairing time so the permission grant covers every
    // flow — OTA, diagnostics, WiFi and the analytics data export.
    const ALL_SERVICES = [UUIDS.OTA_SERVICE, UUIDS.DEBUG_SERVICE, UUIDS.DATA_SERVICE, UUIDS.SYSINFO_SERVICE];

    const REGISTRY_KEY = 'grinderRegistry';
    const ACTIVE_KEY = 'activeGrinderId';
    const SEEN_KEY = 'grinderSeen';
    const IDLE_RELEASE_MS = 30000;
    let holdCount = 0;  // >0 while a long operation owns the link (see hold())
    const SILENT_CONNECT_TIMEOUT_MS = 10000;

    let device = null;
    let server = null;
    let serviceCache = new Map();
    let idleTimer = null;
    let connectPromise = null;
    const attachedDevices = new WeakSet();
    const listeners = new Set();

    // ---- registry ------------------------------------------------------

    function loadRegistry() {
        try { return JSON.parse(localStorage.getItem(REGISTRY_KEY)) || {}; }
        catch { return {}; }
    }

    function saveRegistry(registry) {
        try { localStorage.setItem(REGISTRY_KEY, JSON.stringify(registry)); } catch { /* private mode */ }
    }

    function getActiveId() {
        try { return localStorage.getItem(ACTIVE_KEY); } catch { return null; }
    }

    function setActiveId(id) {
        try {
            if (id) localStorage.setItem(ACTIVE_KEY, id);
            else localStorage.removeItem(ACTIVE_KEY);
        } catch { /* private mode */ }
    }

    function upsertRegistry(dev) {
        const registry = loadRegistry();
        if (!registry[dev.id]) {
            const count = Object.keys(registry).length;
            registry[dev.id] = {
                label: count === 0 ? (dev.name || DEVICE_NAME) : `${dev.name || DEVICE_NAME} ${count + 1}`,
                snapshot: null,
            };
        }
        registry[dev.id].lastSeen = Date.now();
        saveRegistry(registry);
        setActiveId(dev.id);
        try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* private mode */ }
    }

    function getActive() {
        const registry = loadRegistry();
        let id = getActiveId();
        if (!id || !registry[id]) {
            id = Object.keys(registry)[0] || null;
            if (id) setActiveId(id);
        }
        return id ? { id, ...registry[id] } : null;
    }

    function listGrinders() {
        const registry = loadRegistry();
        return Object.entries(registry).map(([id, entry]) => ({ id, ...entry }));
    }

    function setActive(id) {
        if (id === getActiveId()) return;
        disconnectNow();
        device = null;
        setActiveId(id);
        notify('registry');
    }

    function forget(id) {
        const registry = loadRegistry();
        delete registry[id];
        saveRegistry(registry);
        if (getActiveId() === id) {
            disconnectNow();
            device = null;
            setActiveId(Object.keys(registry)[0] || null);
        }
        notify('registry');
    }

    // ---- change notifications -----------------------------------------

    function onChange(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    function notify(type) {
        for (const listener of listeners) {
            try { listener(type); } catch (error) { console.error('GrinderSession listener error:', error); }
        }
    }

    // ---- connection lifecycle -----------------------------------------

    function isSupported() {
        return 'bluetooth' in navigator;
    }

    function isConnected() {
        return !!(server && server.connected);
    }

    function attach(dev) {
        device = dev;
        if (!attachedDevices.has(dev)) {
            attachedDevices.add(dev);
            dev.addEventListener('gattserverdisconnected', () => {
                serviceCache = new Map();
                if (device === dev) notify('disconnect');
            });
        }
    }

    // Chrome 117+ remembers permitted devices across visits; reconnecting to
    // one skips the chooser entirely. Older browsers return null and callers
    // fall back to the interactive path.
    async function findKnownDevice() {
        if (!navigator.bluetooth || typeof navigator.bluetooth.getDevices !== 'function') return null;
        const activeId = getActive()?.id;
        if (!activeId) return null;
        try {
            const devices = await navigator.bluetooth.getDevices();
            return devices.find((d) => d.id === activeId) || null;
        } catch {
            return null;
        }
    }

    // gatt.connect() on a permitted-but-absent device scans indefinitely;
    // silent attempts are raced against a timeout and cancelled.
    async function gattConnect(dev, timeoutMs) {
        if (!timeoutMs) return dev.gatt.connect();
        let timer;
        try {
            return await Promise.race([
                dev.gatt.connect(),
                new Promise((_, reject) => {
                    timer = setTimeout(() => {
                        dev.gatt.disconnect();
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
    async function syncClock() {
        try {
            const service = await getService(UUIDS.SYSINFO_SERVICE);
            const characteristic = await service.getCharacteristic(UUIDS.SYSINFO_TIMESYNC);
            const payload = new ArrayBuffer(6);
            const view = new DataView(payload);
            view.setUint32(0, Math.floor(Date.now() / 1000), true);
            view.setInt16(4, -new Date().getTimezoneOffset(), true);
            await characteristic.writeValue(payload);
        } catch (error) {
            console.log('Clock sync unavailable:', error.message);
        }
    }

    async function connect({ interactive = true } = {}) {
        cancelIdle();
        if (isConnected()) return server;
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
            notify('connect');
            return server;
        })();

        try {
            return await connectPromise;
        } finally {
            connectPromise = null;
        }
    }

    async function getService(uuid) {
        if (!isConnected()) throw new Error('Not connected to a grinder');
        if (!serviceCache.has(uuid)) {
            serviceCache.set(uuid, await server.getPrimaryService(uuid));
        }
        return serviceCache.get(uuid);
    }

    // Keeps the link warm briefly for follow-up actions, then lets go so the
    // grinder is reachable by other tools and its WiFi sync windows.
    function release() {
        if (holdCount > 0) return;  // a long operation owns the link
        cancelIdle();
        idleTimer = setTimeout(() => disconnectNow(), IDLE_RELEASE_MS);
    }

    // Operations that run far longer than the idle window - firmware upload,
    // grind-data export, the diagnostics stream - must hold the link for
    // their duration. Without this, ANY concurrent flow calling release()
    // (e.g. the device strip's background snapshot refresh) arms a 30s timer
    // that disconnects mid-transfer. Always pair with releaseHold() in a
    // finally block; holds nest.
    function hold() {
        holdCount++;
        cancelIdle();
    }

    function releaseHold() {
        if (holdCount > 0) holdCount--;
        if (holdCount === 0) release();
    }

    function cancelIdle() {
        if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
        }
    }

    function disconnectNow() {
        cancelIdle();
        holdCount = 0;  // link is gone; never leave a stuck hold behind
        if (device && device.gatt.connected) device.gatt.disconnect();
        server = null;
        serviceCache = new Map();
    }

    // ---- snapshot ------------------------------------------------------

    async function readJson(serviceUuid, charUuid) {
        const service = await getService(serviceUuid);
        const characteristic = await service.getCharacteristic(charUuid);
        const value = await characteristic.readValue();
        return JSON.parse(new TextDecoder().decode(value));
    }

    function patchSnapshot(id, patch) {
        const registry = loadRegistry();
        if (!registry[id]) return;
        registry[id].snapshot = { ...(registry[id].snapshot || {}), ...patch, fetchedAt: Date.now() };
        registry[id].lastSeen = Date.now();
        saveRegistry(registry);
        notify('snapshot');
    }

    // Reads the cheap characteristics over the current connection. Each read
    // is best-effort so one missing characteristic (older firmware) doesn't
    // lose the rest.
    async function readSnapshotConnected() {
        const snapshot = {};
        try {
            const otaService = await getService(UUIDS.OTA_SERVICE);
            const buildChar = await otaService.getCharacteristic(UUIDS.OTA_BUILD_NUMBER);
            snapshot.build = new TextDecoder().decode(await buildChar.readValue()).trim();
        } catch { /* keep going */ }
        try { snapshot.system = await readJson(UUIDS.SYSINFO_SERVICE, UUIDS.SYSINFO_SYSTEM); } catch { /* keep going */ }
        try { snapshot.sessions = await readJson(UUIDS.SYSINFO_SERVICE, UUIDS.SYSINFO_SESSIONS); } catch { /* keep going */ }
        try { snapshot.wifi = await readJson(UUIDS.SYSINFO_SERVICE, UUIDS.SYSINFO_WIFI_STATUS); } catch { /* keep going */ }
        return snapshot;
    }

    async function refreshSnapshot({ interactive = false } = {}) {
        await connect({ interactive });
        const snapshot = await readSnapshotConnected();
        patchSnapshot(device.id, snapshot);
        release();
        return snapshot;
    }

    // Pairs a grinder explicitly (always shows the chooser), makes it the
    // active one, and takes its first snapshot.
    async function addGrinder() {
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
        notify('connect');
        const snapshot = await readSnapshotConnected();
        patchSnapshot(dev.id, snapshot);
        release();
        return snapshot;
    }

    // Lets flows that already read fresh device state (WiFi status readback,
    // the analytics health capture) fold it into the cached snapshot.
    function applyPatch(patch) {
        const active = getActive();
        if (active) patchSnapshot(active.id, patch);
    }

    function applySystemInfo(systemInfo) {
        if (!systemInfo) return;
        const patch = {};
        if (systemInfo.system) patch.system = systemInfo.system;
        if (systemInfo.sessions) patch.sessions = systemInfo.sessions;
        if (Object.keys(patch).length) applyPatch(patch);
    }

    window.addEventListener('beforeunload', () => disconnectNow());

    window.GrinderSession = {
        UUIDS,
        isSupported,
        isConnected,
        connect,
        getService,
        release,
        hold,
        releaseHold,
        disconnectNow,
        refreshSnapshot,
        addGrinder,
        getActive,
        listGrinders,
        setActive,
        forget,
        applyPatch,
        applySystemInfo,
        onChange,
        get device() { return device; },
        get server() { return server; },
    };
})();
