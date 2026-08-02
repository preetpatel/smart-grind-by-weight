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

// What the grinder can't record: what went in and what it was set to. Keyed by
// the session's content hash, written locally first, and synced to a cloud
// store only when one exists — annotating must not require an account.
export interface Annotation {
    sha256: string;
    bean: string | null;
    roast_date: string | null;
    grind_setting: string | null;
    note: string | null;
    tags: string[];
    /** Which bag was in the hopper — soft reference to a cloud bean (bn_…).
     *  Optional: rows written before beans existed simply lack the fields. */
    bean_id?: string | null;
    /** Shot yield in grams over brew_time_s seconds, logged on the grinder's
     *  post-shot screen or edited here. */
    brew_output_g?: number | null;
    brew_time_s?: number | null;
    /** ISO 8601; the field conflicts are resolved on, last write wins. */
    updated_at: string;
}

export const EMPTY_ANNOTATION: Omit<Annotation, 'sha256' | 'updated_at'> = {
    bean: null,
    roast_date: null,
    grind_setting: null,
    note: null,
    tags: [],
    bean_id: null,
    brew_output_g: null,
    brew_time_s: null,
};

// A bean is one bag of coffee, owned by the cloud store (the server is the
// source of truth; the browser holds a read cache for offline rendering).
export interface Bean {
    id: string;
    name: string;
    ratio: number;
    brew_time_s: number;
    roast_date: string | null;
    notes: string | null;
    archived: boolean;
    created_at: string;
    updated_at: string;
}

export type AdviceVerdict = 'finer' | 'coarser' | 'ok' | 'none';

export interface BeanAdvice {
    verdict: AdviceVerdict;
    shots_considered: number;
    median_deviation_pct: number | null;
}
