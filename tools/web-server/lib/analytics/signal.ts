// Signal-processing helpers for the Vibration Analysis tab, porting the
// scipy/numpy operations used by the Streamlit report: linear detrend, DFT,
// IIR filtering, and the RBJ notch filter design behind scipy.signal.iirnotch.

import { at } from './frame';

// scipy.signal.detrend(type='linear'): subtract the least-squares straight
// line fitted against sample index.
export function detrendLinear(values: number[]): number[] {
    const n = values.length;
    if (n < 2) return values.slice();
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumXX = 0;
    for (const [i, value] of values.entries()) {
        sumX += i;
        sumY += value;
        sumXY += i * value;
        sumXX += i * i;
    }
    const denom = n * sumXX - sumX * sumX;
    const slope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
    const intercept = (sumY - slope * sumX) / n;
    return values.map((v, i) => v - (slope * i + intercept));
}

// One-sided amplitude spectrum matching the report's numpy recipe:
//   yf = fft(x); freqs = fftfreq(N, 1/fs)[:N/2]; amps = 2/N * |yf[:N/2]|
// Direct DFT — O(N^2) is fine for the few hundred samples of a grind phase.
export function amplitudeSpectrum(
    values: number[],
    samplingRate: number,
): { freqs: number[]; amps: number[] } {
    const n = values.length;
    if (n === 0 || samplingRate <= 0) return { freqs: [], amps: [] };
    const half = Math.floor(n / 2);
    const freqs = new Array<number>(half);
    const amps = new Array<number>(half);
    const twoPiOverN = (2 * Math.PI) / n;
    for (let k = 0; k < half; k++) {
        let re = 0;
        let im = 0;
        for (const [i, value] of values.entries()) {
            const angle = twoPiOverN * k * i;
            re += value * Math.cos(angle);
            im -= value * Math.sin(angle);
        }
        freqs[k] = (k * samplingRate) / n;
        amps[k] = (2 / n) * Math.hypot(re, im);
    }
    return { freqs, amps };
}

// scipy.signal.lfilter for a transfer function b/a (direct form II transposed).
export function lfilter(b: number[], a: number[], x: number[]): number[] {
    // An empty denominator is a caller bug; a0 is then NaN and the whole
    // response is NaN, as it was before.
    const a0 = at(a, 0);
    const bn = b.map((v) => v / a0);
    const an = a.map((v) => v / a0);
    const order = Math.max(bn.length, an.length) - 1;
    const state: number[] = new Array(order).fill(0);
    const y = new Array<number>(x.length);
    const b0 = at(bn, 0);
    for (const [i, xi] of x.entries()) {
        const yi = b0 * xi + (order > 0 ? at(state, 0) : 0);
        for (let j = 0; j < order; j++) {
            const bj = j + 1 < bn.length ? at(bn, j + 1) : 0;
            const aj = j + 1 < an.length ? at(an, j + 1) : 0;
            const next = j + 1 < order ? at(state, j + 1) : 0;
            state[j] = bj * xi - aj * yi + next;
        }
        y[i] = yi;
    }
    return y;
}

// scipy.signal.iirnotch: biquad notch at f0 Hz with quality factor Q,
// following scipy's exact design (bandwidth set by the -3 dB points via
// beta = tan(bw*pi/2)), which differs slightly from the RBJ cookbook notch.
export function iirnotch(f0: number, Q: number, fs: number): { b: number[]; a: number[] } {
    const w0 = f0 / (fs / 2); // normalized to Nyquist, 0..1
    const bw = w0 / Q;
    const beta = Math.tan((bw * Math.PI) / 2);
    const gain = 1 / (1 + beta);
    const cosW0 = Math.cos(w0 * Math.PI);
    return {
        b: [gain, -2 * gain * cosW0, gain],
        a: [1, -2 * gain * cosW0, 2 * gain - 1],
    };
}
