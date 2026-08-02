import type { ParsedGrindEvent, ParsedGrindMeasurement, ParsedGrindSession } from '@/lib/parser';

// Canonical stored record shape (IndexedDB, keyed by sha256 of the raw
// session file). `raw` holds the verbatim device bytes for the cloud
// backfill; records imported from pre-v2 JSON exports have none.
export interface StoredRecord {
    sha256: string;
    session_id: number;
    session: ParsedGrindSession;
    events: ParsedGrindEvent[];
    measurements: ParsedGrindMeasurement[];
    raw?: Uint8Array;
    pulledAt: string | null;
    source: 'ble' | 'cloud' | 'import';
}

// Device health capture stored alongside records (BLE pull path).
export interface DeviceReports {
    system_info: {
        system?: Record<string, unknown> | null;
        performance?: Record<string, unknown> | null;
        hardware?: Record<string, unknown> | null;
        sessions?: Record<string, unknown> | null;
    } | null;
    diagnostics: string | null;
    captured_at: string;
}

// Shared view options across the single-session analysis tabs.
export interface ViewOptions {
    includeTaring: boolean;
    smoothingMs: number;
    hiddenPhases: Set<string>;
    vibration: {
        showIir: boolean;
        alpha: number;
        showNotch: boolean;
        notchFreq: number;
        q: number;
    };
}

// Grind accuracy tolerance (g), as in the Streamlit report.
export const TOLERANCE_G = 0.03;

// session_timestamp carries a real Unix epoch once the device clock has been
// synced, and uptime seconds otherwise. Distinguish by magnitude
// (2020-01-01 epoch is far above any plausible uptime).
export const EPOCH_THRESHOLD = 1577836800;

export function isEpochTimestamp(ts: number): boolean {
    return ts >= EPOCH_THRESHOLD;
}
