// Signal-processing helpers for the Vibration Analysis tab, porting the
// scipy/numpy operations used by the Streamlit report: linear detrend, DFT,
// IIR filtering, and the RBJ notch filter design behind scipy.signal.iirnotch.

// scipy.signal.detrend(type='linear'): subtract the least-squares straight
// line fitted against sample index.
export function detrendLinear(values) {
    const n = values.length;
    if (n < 2) return values.slice();
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumXX = 0;
    for (let i = 0; i < n; i++) {
        sumX += i;
        sumY += values[i];
        sumXY += i * values[i];
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
export function amplitudeSpectrum(values, samplingRate) {
    const n = values.length;
    if (n === 0 || samplingRate <= 0) return { freqs: [], amps: [] };
    const half = Math.floor(n / 2);
    const freqs = new Array(half);
    const amps = new Array(half);
    const twoPiOverN = (2 * Math.PI) / n;
    for (let k = 0; k < half; k++) {
        let re = 0;
        let im = 0;
        for (let i = 0; i < n; i++) {
            const angle = twoPiOverN * k * i;
            re += values[i] * Math.cos(angle);
            im -= values[i] * Math.sin(angle);
        }
        freqs[k] = (k * samplingRate) / n;
        amps[k] = (2 / n) * Math.hypot(re, im);
    }
    return { freqs, amps };
}

// scipy.signal.lfilter for a transfer function b/a (direct form II transposed).
export function lfilter(b, a, x) {
    const a0 = a[0];
    const bn = b.map((v) => v / a0);
    const an = a.map((v) => v / a0);
    const order = Math.max(bn.length, an.length) - 1;
    const state = new Array(order).fill(0);
    const y = new Array(x.length);
    for (let i = 0; i < x.length; i++) {
        const xi = x[i];
        const yi = bn[0] * xi + (order > 0 ? state[0] : 0);
        for (let j = 0; j < order; j++) {
            const bj = j + 1 < bn.length ? bn[j + 1] : 0;
            const aj = j + 1 < an.length ? an[j + 1] : 0;
            const next = j + 1 < order ? state[j + 1] : 0;
            state[j] = bj * xi - aj * yi + next;
        }
        y[i] = yi;
    }
    return y;
}

// scipy.signal.iirnotch: biquad notch at f0 Hz with quality factor Q,
// following scipy's exact design (bandwidth set by the -3 dB points via
// beta = tan(bw*pi/2)), which differs slightly from the RBJ cookbook notch.
export function iirnotch(f0, Q, fs) {
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
