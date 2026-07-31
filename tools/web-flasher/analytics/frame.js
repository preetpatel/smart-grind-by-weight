// Small data helpers standing in for the pandas operations the Streamlit
// report uses. All functions treat measurement arrays as already sorted by
// timestamp_ms (the parser emits them in sequence order).

// Trailing time-window rolling mean, matching pandas
// `series.rolling(window='Xms').mean()` on a millisecond datetime index:
// sample i averages all values with timestamp in (t_i - windowMs, t_i].
export function rollingMeanByTime(timestamps, values, windowMs) {
    const out = new Array(values.length);
    let start = 0;
    let sum = 0;
    let count = 0;
    for (let i = 0; i < values.length; i++) {
        sum += values[i];
        count++;
        while (timestamps[start] <= timestamps[i] - windowMs) {
            sum -= values[start];
            count--;
            start++;
        }
        out[i] = count > 0 ? sum / count : values[i];
    }
    return out;
}

// Linear interpolation at x over sorted (xs, ys), matching np.interp's
// clamping behaviour outside the domain.
export function interpolateAt(x, xs, ys) {
    if (!xs.length) return 0;
    if (x <= xs[0]) return ys[0];
    if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
    let lo = 0;
    let hi = xs.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (xs[mid] <= x) lo = mid;
        else hi = mid;
    }
    const t = (x - xs[lo]) / (xs[hi] - xs[lo]);
    return ys[lo] + t * (ys[hi] - ys[lo]);
}

// Downsample to fixed time bins keeping the last sample per bin, matching
// pandas `resample('100ms').last().dropna()` with the bin's left edge as the
// resulting timestamp.
export function resampleLast(measurements, binMs = 100) {
    const bins = new Map();
    for (const m of measurements) {
        const bin = Math.floor(m.timestamp_ms / binMs) * binMs;
        bins.set(bin, m); // measurements arrive time-sorted, so last write wins
    }
    return [...bins.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([bin, m]) => ({ ...m, timestamp_ms: bin }));
}

// Pearson correlation coefficient, matching pandas DataFrame.corr().
export function pearson(xs, ys) {
    const n = Math.min(xs.length, ys.length);
    if (n < 2) return NaN;
    const meanX = xs.reduce((s, v) => s + v, 0) / n;
    const meanY = ys.reduce((s, v) => s + v, 0) / n;
    let cov = 0;
    let varX = 0;
    let varY = 0;
    for (let i = 0; i < n; i++) {
        const dx = xs[i] - meanX;
        const dy = ys[i] - meanY;
        cov += dx * dy;
        varX += dx * dx;
        varY += dy * dy;
    }
    if (varX === 0 || varY === 0) return NaN;
    return cov / Math.sqrt(varX * varY);
}

export function mean(values) {
    return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}

// Sample standard deviation (ddof=1), matching pandas Series.std().
export function stddev(values) {
    if (values.length < 2) return NaN;
    const m = mean(values);
    return Math.sqrt(values.reduce((s, v) => s + (v - m) * (v - m), 0) / (values.length - 1));
}

export function groupBy(items, keyFn) {
    const groups = new Map();
    for (const item of items) {
        const key = keyFn(item);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
    }
    return groups;
}
