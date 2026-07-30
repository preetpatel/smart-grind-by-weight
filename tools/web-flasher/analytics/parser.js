// Binary parser for grind session files pulled over the BLE data service.
//
// The layout must stay aligned with the packed structs in
// src/logging/grind_logging.h and the Python parser in
// tools/ble/grinder-ble.py (_parse_single_file_data). See tools/ble/CLAUDE.md:
// every struct change on the firmware side requires updating this file too.
//
// File format on device (LittleFS, little-endian):
//   [TimeSeriesSessionHeader (24 bytes)]
//   [GrindSession (80 bytes)]
//   [GrindEvent x event_count (44 bytes each)]
//   [GrindMeasurement x measurement_count (24 bytes each)]

export const LOG_SCHEMA_VERSION = 2;
export const HEADER_SIZE = 24;
export const SESSION_STRUCT_SIZE = 80;
export const EVENT_STRUCT_SIZE = 44;
export const MEASUREMENT_STRUCT_SIZE = 24;

export const PHASE_NAMES = {
    0: 'IDLE', 1: 'INITIALIZING', 2: 'SETUP', 3: 'TARING', 4: 'TARE_CONFIRM',
    5: 'PREDICTIVE', 6: 'PULSE_DECISION', 7: 'PULSE_EXECUTE', 8: 'PULSE_SETTLING',
    9: 'FINAL_SETTLING', 10: 'TIME_GRINDING', 11: 'TIME_ADDITIONAL_PULSE',
    12: 'COMPLETED', 13: 'TIMEOUT', 14: 'PRIME', 15: 'PRIME_SETTLING', 16: 'PURGE_CONFIRM',
};

export const PROFILE_MAP = { 0: 'SINGLE', 1: 'DOUBLE', 2: 'CUSTOM' };
export const MODE_MAP = { 0: 'WEIGHT', 1: 'TIME' };
export const TERMINATION_REASON_MAP = {
    0: 'COMPLETE', 1: 'TIMEOUT', 2: 'OVERSHOOT', 3: 'MAX_PULSES', 255: 'UNKNOWN',
};

function phaseName(phaseId) {
    return PHASE_NAMES[phaseId] ?? 'UNKNOWN';
}

// Parses one session file into { session, events, measurements }.
// Throws on any validation failure, mirroring the Python parser's behaviour of
// rejecting the whole session rather than importing corrupt data.
export function parseSessionFile(arrayBuffer, expectedSessionId) {
    const view = new DataView(arrayBuffer);
    if (arrayBuffer.byteLength < HEADER_SIZE + SESSION_STRUCT_SIZE) {
        throw new Error(`File data too small: ${arrayBuffer.byteLength} bytes`);
    }

    let offset = 0;

    // TimeSeriesSessionHeader
    const hdrSessionId = view.getUint32(0, true);
    const hdrSessionSize = view.getUint32(8, true);
    const hdrChecksum = view.getUint32(12, true);
    const eventCount = view.getUint16(16, true);
    const measurementCount = view.getUint16(18, true);
    const schemaVersion = view.getUint16(20, true);
    offset += HEADER_SIZE;

    if (hdrSessionId !== expectedSessionId) {
        throw new Error(`Header session ID mismatch: expected ${expectedSessionId}, got ${hdrSessionId}`);
    }
    const warnings = [];
    if (schemaVersion !== LOG_SCHEMA_VERSION) {
        warnings.push(`Session ${expectedSessionId} uses schema ${schemaVersion}, expected ${LOG_SCHEMA_VERSION}. Attempting to parse anyway.`);
    }

    // GrindSession
    const s = offset;
    const sessionId = view.getUint32(s + 0, true);
    if (sessionId !== expectedSessionId) {
        throw new Error(`Session ID mismatch: expected ${expectedSessionId}, got ${sessionId}`);
    }

    const resultBytes = new Uint8Array(arrayBuffer, s + 64, 16);
    const nul = resultBytes.indexOf(0);
    const resultStatus = new TextDecoder().decode(nul === -1 ? resultBytes : resultBytes.subarray(0, nul));

    const session = {
        session_id: sessionId,
        session_timestamp: view.getUint32(s + 4, true),
        target_time_ms: view.getUint32(s + 8, true),
        total_time_ms: view.getUint32(s + 12, true),
        total_motor_on_time_ms: view.getUint32(s + 16, true),
        time_error_ms: view.getInt32(s + 20, true),
        target_weight: view.getFloat32(s + 24, true),
        tolerance: view.getFloat32(s + 28, true),
        final_weight: view.getFloat32(s + 32, true),
        error_grams: view.getFloat32(s + 36, true),
        start_weight: view.getFloat32(s + 40, true),
        initial_motor_stop_offset: view.getFloat32(s + 44, true),
        latency_to_coast_ratio: view.getFloat32(s + 48, true),
        flow_rate_threshold: view.getFloat32(s + 52, true),
        profile_id: view.getUint8(s + 56),
        grind_mode: view.getUint8(s + 57),
        max_pulse_attempts: view.getUint8(s + 58),
        pulse_count: view.getUint8(s + 59),
        termination_reason: view.getUint8(s + 60),
        schema_version: schemaVersion,
        result_status: resultStatus,
        session_size_bytes: hdrSessionSize,
        checksum: hdrChecksum,
    };
    offset += SESSION_STRUCT_SIZE;

    // GrindEvent records
    const events = [];
    let expectedEventSequence = 0;
    for (let i = 0; i < eventCount; i++) {
        if (offset + EVENT_STRUCT_SIZE > arrayBuffer.byteLength) {
            throw new Error(`File too small for event at offset ${offset}`);
        }
        const e = offset;
        const timestampMs = view.getUint32(e + 0, true);
        const phaseId = view.getUint8(e + 40);
        const eventSequenceId = view.getUint16(e + 36, true);

        if (timestampMs === 0xFFFFFFFF || phaseId === 0xFF) { // invalid/empty slot
            expectedEventSequence++;
            offset += EVENT_STRUCT_SIZE;
            continue;
        }
        if (eventSequenceId !== expectedEventSequence) {
            throw new Error(`Event sequence out of order: expected ${expectedEventSequence}, got ${eventSequenceId} at event ${i}`);
        }

        events.push({
            session_id: sessionId,
            event_sequence_id: eventSequenceId,
            timestamp_ms: timestampMs,
            phase_id: phaseId,
            phase_name: phaseName(phaseId),
            pulse_attempt_number: view.getUint8(e + 41),
            duration_ms: view.getUint32(e + 4, true),
            start_weight: view.getFloat32(e + 16, true),
            end_weight: view.getFloat32(e + 20, true),
            motor_stop_target_weight: view.getFloat32(e + 24, true),
            pulse_duration_ms: view.getFloat32(e + 28, true),
            grind_latency_ms: view.getUint32(e + 8, true),
            settling_duration_ms: view.getUint32(e + 12, true),
            pulse_flow_rate: view.getFloat32(e + 32, true),
            loop_count: view.getUint16(e + 38, true),
            event_flags: view.getUint8(e + 42),
        });
        expectedEventSequence++;
        offset += EVENT_STRUCT_SIZE;
    }

    // GrindMeasurement records
    const measurements = [];
    let expectedMeasurementSequence = 0;
    for (let i = 0; i < measurementCount; i++) {
        if (offset + MEASUREMENT_STRUCT_SIZE > arrayBuffer.byteLength) {
            throw new Error(`File too small for measurement at offset ${offset}`);
        }
        const m = offset;
        const timestampMs = view.getUint32(m + 0, true);
        const weightGrams = view.getFloat32(m + 4, true);
        const sequenceId = view.getUint16(m + 20, true);

        if (timestampMs === 0xFFFFFFFF || weightGrams === -999.0) { // invalid slot
            expectedMeasurementSequence++;
            offset += MEASUREMENT_STRUCT_SIZE;
            continue;
        }
        if (sequenceId !== expectedMeasurementSequence) {
            throw new Error(`Session ${sessionId} corrupted: measurement sequence error at index ${i} (expected ${expectedMeasurementSequence}, got ${sequenceId})`);
        }

        const phaseId = view.getUint8(m + 23);
        measurements.push({
            session_id: sessionId,
            sequence_id: sequenceId,
            timestamp_ms: timestampMs,
            weight_grams: weightGrams,
            weight_delta: view.getFloat32(m + 8, true),
            flow_rate_g_per_s: view.getFloat32(m + 12, true),
            motor_is_on: view.getUint8(m + 22),
            phase_id: phaseId,
            phase_name: phaseName(phaseId),
            motor_stop_target_weight: view.getFloat32(m + 16, true),
        });
        expectedMeasurementSequence++;
        offset += MEASUREMENT_STRUCT_SIZE;
    }

    return { session, events, measurements, warnings };
}
