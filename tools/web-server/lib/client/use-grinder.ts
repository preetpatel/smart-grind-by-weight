'use client';

// React bindings for the shared BLE session singleton (lib/client/ble.ts).
import { useCallback, useSyncExternalStore } from 'react';
import * as ble from './ble';

export interface GrinderState {
    supported: boolean;
    connected: boolean;
    active: ble.ActiveGrinder | null;
    grinders: ble.ActiveGrinder[];
}

const SERVER_STATE: GrinderState = {
    supported: false,
    connected: false,
    active: null,
    grinders: [],
};

// The registry version bumps on every session/registry change; derived state
// is recomputed (and cached per version) so useSyncExternalStore sees stable
// snapshots.
let cachedVersion = -1;
let cachedState: GrinderState = SERVER_STATE;

function getSnapshot(): GrinderState {
    const version = ble.getRegistryVersion();
    if (version !== cachedVersion) {
        cachedVersion = version;
        cachedState = {
            supported: ble.isSupported(),
            connected: ble.isConnected(),
            active: ble.getActive(),
            grinders: ble.listGrinders(),
        };
    }
    return cachedState;
}

export function useGrinder(): GrinderState {
    const subscribe = useCallback((listener: () => void) => ble.subscribe(listener), []);
    return useSyncExternalStore(subscribe, getSnapshot, () => SERVER_STATE);
}
