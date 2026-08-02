// Builds synthetic session files byte-identical in layout to what the
// firmware writes to LittleFS (src/logging/grind_logging.h, packed structs,
// little-endian): header (24) + GrindSession (80) + events (44 ea) +
// measurements (24 ea).
import { crc32 } from 'node:zlib';

export const HEADER_SIZE = 24;
export const SESSION_SIZE = 80;
export const EVENT_SIZE = 44;
export const MEASUREMENT_SIZE = 24;

export interface SessionBlobOptions {
    sessionId?: number;
    timestamp?: number;
    eventCount?: number;
    measurementCount?: number;
    schemaVersion?: number;
    /** null → legacy 0; 'crc32' → real CRC of the payload; number → verbatim */
    checksum?: number | 'crc32' | null;
    targetWeight?: number;
    finalWeight?: number;
    resultStatus?: string;
    corruptEventSequence?: boolean;
    corruptMeasurementSequence?: boolean;
}

export function buildSessionBlob({
    sessionId = 1,
    timestamp = 1754000000,
    eventCount = 2,
    measurementCount = 5,
    schemaVersion = 2,
    checksum = null,
    targetWeight = 18,
    finalWeight = 18.02,
    resultStatus = 'COMPLETE',
    corruptEventSequence = false,
    corruptMeasurementSequence = false,
}: SessionBlobOptions = {}): ArrayBuffer {
    const sessionSize =
        SESSION_SIZE + eventCount * EVENT_SIZE + measurementCount * MEASUREMENT_SIZE;
    const buffer = new ArrayBuffer(HEADER_SIZE + sessionSize);
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);

    // GrindSession
    const s = HEADER_SIZE;
    view.setUint32(s + 0, sessionId, true);
    view.setUint32(s + 4, timestamp, true);
    view.setUint32(s + 12, 8000, true); // total_time_ms
    view.setUint32(s + 16, 6000, true); // total_motor_on_time_ms
    view.setFloat32(s + 24, targetWeight, true);
    view.setFloat32(s + 28, 0.05, true); // tolerance
    view.setFloat32(s + 32, finalWeight, true);
    view.setFloat32(s + 36, targetWeight - finalWeight, true);
    view.setUint8(s + 56, 1); // profile_id
    view.setUint8(s + 57, 0); // grind_mode = WEIGHT
    view.setUint8(s + 58, 10); // max_pulse_attempts
    view.setUint8(s + 59, 2); // pulse_count
    view.setUint8(s + 60, 0); // termination_reason
    bytes.set(new TextEncoder().encode(resultStatus.slice(0, 15)), s + 64);

    // GrindEvents
    for (let i = 0; i < eventCount; i++) {
        const e = HEADER_SIZE + SESSION_SIZE + i * EVENT_SIZE;
        view.setUint32(e + 0, 100 + i * 500, true); // timestamp_ms
        view.setUint32(e + 4, 500, true); // duration_ms
        view.setFloat32(e + 16, i * 2, true); // start_weight
        view.setFloat32(e + 20, i * 2 + 2, true); // end_weight
        view.setUint16(e + 36, corruptEventSequence ? i + 7 : i, true); // event_sequence_id
        view.setUint8(e + 40, 5); // phase_id = PREDICTIVE
    }

    // GrindMeasurements
    for (let i = 0; i < measurementCount; i++) {
        const m = HEADER_SIZE + SESSION_SIZE + eventCount * EVENT_SIZE + i * MEASUREMENT_SIZE;
        view.setUint32(m + 0, 100 + i * 20, true); // timestamp_ms
        view.setFloat32(m + 4, i * 0.5, true); // weight_grams
        view.setFloat32(m + 8, 0.5, true); // weight_delta
        view.setFloat32(m + 12, 2.5, true); // flow_rate
        view.setUint16(m + 20, corruptMeasurementSequence ? i + 3 : i, true); // sequence_id
        view.setUint8(m + 22, 1); // motor_is_on
        view.setUint8(m + 23, 5); // phase_id
    }

    // TimeSeriesSessionHeader (checksum last: it covers everything after the header)
    view.setUint32(0, sessionId, true);
    view.setUint32(4, timestamp, true);
    view.setUint32(8, sessionSize, true);
    view.setUint16(16, eventCount, true);
    view.setUint16(18, measurementCount, true);
    view.setUint16(20, schemaVersion, true);
    if (checksum === 'crc32') {
        view.setUint32(12, crc32(bytes.subarray(HEADER_SIZE)) >>> 0, true);
    } else {
        view.setUint32(12, checksum ?? 0, true);
    }
    return buffer;
}
