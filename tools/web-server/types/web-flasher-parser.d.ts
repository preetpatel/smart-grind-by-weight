// Types for the shared session-file parser in tools/web-flasher/analytics/parser.js.
// The implementation stays plain JS (it ships unbundled to browsers); this
// declaration types the server's import of the same file so JS keeps a single
// parser source (docs/CLOUD_SYNC.md). Field names mirror the packed structs
// in src/logging/grind_logging.h.
declare module '*analytics/parser.js' {
    export const LOG_SCHEMA_VERSION: number;
    export const HEADER_SIZE: number;
    export const SESSION_STRUCT_SIZE: number;
    export const EVENT_STRUCT_SIZE: number;
    export const MEASUREMENT_STRUCT_SIZE: number;

    export const PHASE_NAMES: Record<number, string>;
    export const PROFILE_MAP: Record<number, string>;
    export const MODE_MAP: Record<number, string>;
    export const TERMINATION_REASON_MAP: Record<number, string>;

    export interface ParsedGrindSession {
        session_id: number;
        session_timestamp: number;
        target_time_ms: number;
        total_time_ms: number;
        total_motor_on_time_ms: number;
        time_error_ms: number;
        target_weight: number;
        tolerance: number;
        final_weight: number;
        error_grams: number;
        start_weight: number;
        initial_motor_stop_offset: number;
        latency_to_coast_ratio: number;
        flow_rate_threshold: number;
        profile_id: number;
        grind_mode: number;
        max_pulse_attempts: number;
        pulse_count: number;
        termination_reason: number;
        schema_version: number;
        result_status: string;
        session_size_bytes: number;
        checksum: number;
    }

    export interface ParsedGrindEvent {
        session_id: number;
        event_sequence_id: number;
        timestamp_ms: number;
        phase_id: number;
        phase_name: string;
        pulse_attempt_number: number;
        duration_ms: number;
        start_weight: number;
        end_weight: number;
        motor_stop_target_weight: number;
        pulse_duration_ms: number;
        grind_latency_ms: number;
        settling_duration_ms: number;
        pulse_flow_rate: number;
        loop_count: number;
        event_flags: number;
    }

    export interface ParsedGrindMeasurement {
        session_id: number;
        sequence_id: number;
        timestamp_ms: number;
        weight_grams: number;
        weight_delta: number;
        flow_rate_g_per_s: number;
        motor_is_on: number;
        phase_id: number;
        phase_name: string;
        motor_stop_target_weight: number;
    }

    export interface ParsedSessionFile {
        session: ParsedGrindSession;
        events: ParsedGrindEvent[];
        measurements: ParsedGrindMeasurement[];
        warnings: string[];
    }

    export function parseSessionFile(
        arrayBuffer: ArrayBuffer,
        expectedSessionId: number,
    ): ParsedSessionFile;
}
