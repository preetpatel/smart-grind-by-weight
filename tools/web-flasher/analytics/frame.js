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

export function groupBy(items, keyFn) {
    const groups = new Map();
    for (const item of items) {
        const key = keyFn(item);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
    }
    return groups;
}
