// Port of tools/streamlit-reports/circular_buffer_math.py, which itself
// mirrors the firmware's CircularBufferMath::get_raw_flow_rate_95th_percentile.
// Keep all three in sync.

const HW_LOADCELL_SAMPLE_RATE_SPS = 10;
const MIN_SAMPLES_FOR_PERCENTILE = 10;
const MIN_SUB_WINDOWS = 4;
const MAX_SUB_WINDOWS = 32;
const MIN_SAMPLES_PER_SUB_WINDOW = 3;

interface FlowSample {
    timestamp_ms: number;
    weight_grams: number;
}

// samples: [{timestamp_ms, weight_grams}] sorted ascending by timestamp.
// uptoIndex: only samples[0..uptoIndex] are visible (data available "so far").
function simpleFlowRate(
    samples: FlowSample[],
    uptoIndex: number,
    currentTs: number,
    windowMs: number,
): number {
    const windowStart = currentTs - windowMs;
    let first: FlowSample | null = null;
    let last: FlowSample | null = null;
    for (let i = 0; i <= uptoIndex; i++) {
        const s = samples[i];
        if (!s) continue;
        if (s.timestamp_ms >= windowStart && s.timestamp_ms <= currentTs) {
            if (first === null) first = s;
            last = s;
        }
    }
    if (!first || !last || first === last) return 0;
    const timeChange = last.timestamp_ms - first.timestamp_ms;
    if (timeChange === 0) return 0;
    return ((last.weight_grams - first.weight_grams) * 1000) / timeChange;
}

function percentile95At(
    samples: FlowSample[],
    uptoIndex: number,
    currentTs: number,
    windowMs: number,
    subWindowMs: number,
    stepMs: number,
): number {
    if (uptoIndex + 1 < MIN_SAMPLES_FOR_PERCENTILE) {
        return simpleFlowRate(samples, uptoIndex, currentTs, windowMs);
    }

    const minWindowForSamples = Math.floor(
        (MIN_SAMPLES_FOR_PERCENTILE * 1000) / HW_LOADCELL_SAMPLE_RATE_SPS,
    );
    const effectiveWindowMs = Math.max(windowMs, minWindowForSamples);
    const windowStart = currentTs - effectiveWindowMs;

    const collected: FlowSample[] = [];
    for (let i = 0; i <= uptoIndex; i++) {
        const s = samples[i];
        if (s && s.timestamp_ms >= windowStart && s.timestamp_ms <= currentTs) collected.push(s);
    }
    if (collected.length < MIN_SAMPLES_FOR_PERCENTILE) {
        return simpleFlowRate(samples, uptoIndex, currentTs, effectiveWindowMs);
    }

    let numSubWindows = 1 + Math.floor(Math.max(0, effectiveWindowMs - subWindowMs) / stepMs);
    numSubWindows = Math.max(MIN_SUB_WINDOWS, Math.min(MAX_SUB_WINDOWS, numSubWindows));

    const flowRates: number[] = [];
    for (let i = 0; i < numSubWindows; i++) {
        const subEnd = currentTs - i * stepMs;
        const subStart = subEnd - subWindowMs;
        let oldest: FlowSample | null = null;
        let newest: FlowSample | null = null;
        for (const s of collected) {
            if (s.timestamp_ms >= subStart && s.timestamp_ms <= subEnd) {
                if (!oldest || s.timestamp_ms < oldest.timestamp_ms) oldest = s;
                if (!newest || s.timestamp_ms > newest.timestamp_ms) newest = s;
            }
        }
        let count = 0;
        for (const s of collected) {
            if (s.timestamp_ms >= subStart && s.timestamp_ms <= subEnd) count++;
        }
        if (count >= MIN_SAMPLES_PER_SUB_WINDOW && newest && oldest) {
            const timeDelta = newest.timestamp_ms - oldest.timestamp_ms;
            if (timeDelta > 0) {
                flowRates.push(((newest.weight_grams - oldest.weight_grams) * 1000) / timeDelta);
            }
        }
    }

    if (flowRates.length >= MIN_SAMPLES_PER_SUB_WINDOW) {
        flowRates.sort((a, b) => a - b);
        let idx = Math.floor(flowRates.length * 0.95);
        if (idx >= flowRates.length) idx = flowRates.length - 1;
        // The guard above puts idx in range; the fallback is unreachable.
        return flowRates[idx] ?? 0;
    }
    return simpleFlowRate(samples, uptoIndex, currentTs, effectiveWindowMs);
}

// Simulates calling the firmware's percentile calculation at each sample time,
// like calculate_95th_percentile_series. Returns one flow value per sample.
export function percentile95Series(
    samples: Array<{ timestamp_ms: number; weight_grams: number }>,
    {
        windowMs = 200,
        subWindowMs = 300,
        stepMs = 100,
    }: { windowMs?: number; subWindowMs?: number; stepMs?: number } = {},
): Array<{ timestamp_ms: number; flow_rate_95p: number }> {
    const sorted = [...samples].sort((a, b) => a.timestamp_ms - b.timestamp_ms);
    return sorted.map((s, i) => ({
        timestamp_ms: s.timestamp_ms,
        flow_rate_95p: percentile95At(sorted, i, s.timestamp_ms, windowMs, subWindowMs, stepMs),
    }));
}
