// The numeric core of the dashboard: rolling means, interpolation, detrend,
// DFT, IIR filtering and the firmware's 95th-percentile flow estimate. These
// port scipy/numpy/pandas behaviour that the charts are read as if it were
// exact, and until now none of it was covered.
//
// Two layers on purpose. The first asserts hand-checkable results — an impulse
// response, a sine at a known frequency, a straight line detrended to zero —
// so the tests say what the functions are *supposed* to do rather than merely
// what they currently return. The second pins sampled values from a
// deterministic signal, which is what catches silent drift in a refactor.
import { describe, expect, it } from 'vitest';
import {
    interpolateAt,
    mean,
    pearson,
    resampleLast,
    rollingMeanByTime,
    stddev,
} from '@/lib/analytics/frame';
import { percentile95Series } from '@/lib/analytics/percentile';
import { amplitudeSpectrum, detrendLinear, iirnotch, lfilter } from '@/lib/analytics/signal';

// Deterministic pseudo-random source, so the drift fixture is reproducible.
function lcg(seed: number): () => number {
    let state = seed;
    return () => {
        state = (state * 1103515245 + 12345) % 2147483648;
        return state / 2147483648;
    };
}

const SAMPLES = 120;
const TIMES = Array.from({ length: SAMPLES }, (_, i) => i * 25 + (i % 7));
const SIGNAL = (() => {
    const rand = lcg(42);
    return Array.from({ length: SAMPLES }, (_, i) => Math.sin(i / 5) * 3 + rand() * 0.4 + i * 0.01);
})();

describe('frame helpers', () => {
    it('averages a trailing time window, excluding its left edge', () => {
        // pandas rolling(window='250ms'): sample i covers (t_i - 250, t_i].
        // At t=300 the t=0 sample has just fallen out of the window.
        expect(rollingMeanByTime([0, 100, 200, 300], [1, 2, 3, 4], 250)).toEqual([1, 1.5, 2, 3]);
    });

    it('survives empty and single-sample inputs', () => {
        expect(rollingMeanByTime([], [], 500)).toEqual([]);
        expect(rollingMeanByTime([5], [2], 500)).toEqual([2]);
    });

    it('interpolates linearly and clamps outside the domain, like np.interp', () => {
        expect(interpolateAt(150, [100, 200], [10, 20])).toBe(15);
        expect(interpolateAt(-1e9, [100, 200], [10, 20])).toBe(10);
        expect(interpolateAt(1e9, [100, 200], [10, 20])).toBe(20);
        expect(interpolateAt(3, [], [])).toBe(0);
    });

    it('keeps the last sample in each bin when downsampling', () => {
        const rows = [0, 40, 90, 110, 260].map((t) => ({ timestamp_ms: t }));
        expect(resampleLast(rows, 100).map((r) => r.timestamp_ms)).toEqual([0, 100, 200]);
    });

    it('reports correlation, mean and sample standard deviation', () => {
        expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBe(1);
        expect(pearson([1, 2, 3], [3, 2, 1])).toBe(-1);
        // Undefined rather than 0 when a series never varies.
        expect(pearson([1, 1, 1], [1, 2, 3])).toBeNaN();
        expect(pearson([1], [2])).toBeNaN();
        expect(mean([2, 4, 6])).toBe(4);
        expect(mean([])).toBe(0);
        // ddof=1, matching pandas Series.std() — not the population figure of 2.
        expect(stddev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.1380899, 7);
        expect(stddev([3])).toBeNaN();
    });
});

describe('signal helpers', () => {
    it('detrends a straight line to zero', () => {
        for (const value of detrendLinear([1, 2, 3, 4, 5])) {
            expect(value).toBeCloseTo(0, 12);
        }
        expect(detrendLinear([4])).toEqual([4]);
    });

    it('finds a known sine at its own frequency and amplitude', () => {
        const fs = 16;
        const wave = Array.from({ length: 16 }, (_, i) => Math.sin((2 * Math.PI * 2 * i) / 16));
        const { freqs, amps } = amplitudeSpectrum(wave, fs);
        const peak = amps.indexOf(Math.max(...amps));
        expect(freqs[peak]).toBe(2);
        expect(amps[peak]).toBeCloseTo(1, 9);
        expect(amplitudeSpectrum([], fs)).toEqual({ freqs: [], amps: [] });
    });

    it('filters like scipy.signal.lfilter', () => {
        // FIR: the impulse response is the coefficient list itself.
        expect(lfilter([0.5, 0.5], [1], [1, 0, 0, 0])).toEqual([0.5, 0.5, 0, 0]);
        // IIR 1/(1 - 0.5 z^-1): a geometric decay.
        expect(lfilter([1], [1, -0.5], [1, 0, 0, 0])).toEqual([1, 0.5, 0.25, 0.125]);
        // Coefficients are normalised by a0, so scaling both sides is a no-op.
        expect(lfilter([2, 1], [4, 0.5], SIGNAL.slice(0, 8))).toEqual(
            lfilter([1, 0.5], [2, 0.25], SIGNAL.slice(0, 8)),
        );
    });

    it('designs a symmetric notch biquad', () => {
        const { b, a } = iirnotch(50, 30, 1000);
        expect(b[0]).toBeCloseTo(b[2] as number, 12);
        expect(a[0]).toBe(1);
        // scipy's design puts the middle coefficients equal and a2 = 2*gain - 1.
        expect(a[1]).toBeCloseTo(b[1] as number, 12);
        expect(a[2]).toBeCloseTo(2 * (b[0] as number) - 1, 12);
    });
});

describe('95th-percentile flow', () => {
    it('reads a constant ramp as its true flow rate', () => {
        // 0.5 g every 100 ms is 5 g/s.
        const ramp = Array.from({ length: 20 }, (_, i) => ({
            timestamp_ms: i * 100,
            weight_grams: i * 0.5,
        }));
        const series = percentile95Series(ramp);
        expect(series).toHaveLength(20);
        expect(series[0]?.flow_rate_95p).toBe(0);
        expect(series.at(-1)?.flow_rate_95p).toBeCloseTo(5, 9);
    });

    it('handles too-short and empty inputs', () => {
        expect(percentile95Series([])).toEqual([]);
        expect(
            percentile95Series([0, 100, 200].map((t, i) => ({ timestamp_ms: t, weight_grams: i }))),
        ).toHaveLength(3);
    });
});

// Sampled from a fixed pseudo-random signal. These have no independent meaning
// — they exist so that a change in any of the maths above has to be deliberate.
describe('no drift on a fixed signal', () => {
    it('reproduces sampled values', () => {
        expect(rollingMeanByTime(TIMES, SIGNAL, 500)[60]).toBeCloseTo(0.037245063656931275, 15);
        expect(detrendLinear(SIGNAL)[60]).toBeCloseTo(-1.5640741548783352, 15);
        expect(amplitudeSpectrum(SIGNAL, 40).amps[10]).toBeCloseTo(0.08014756238639681, 15);
        const notch = iirnotch(12, 8, 40);
        expect(lfilter(notch.b, notch.a, SIGNAL)[60]).toBeCloseTo(-0.7260123987816461, 15);
        expect(mean(SIGNAL)).toBeCloseTo(0.8765811831725616, 15);
        expect(stddev(SIGNAL)).toBeCloseTo(2.119271620127055, 15);
        expect(interpolateAt(17.3, TIMES, SIGNAL)).toBeCloseTo(0.6195197627897175, 15);

        const flow = percentile95Series(
            TIMES.map((t, i) => ({ timestamp_ms: t, weight_grams: Math.abs(SIGNAL[i] ?? 0) })),
        );
        expect(flow[60]?.flow_rate_95p).toBeCloseTo(11.076016882627604, 12);
    });
});
