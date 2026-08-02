// Small data helpers standing in for the pandas operations the Streamlit
// report uses. All functions treat measurement arrays as already sorted by
// timestamp_ms (the parser emits them in sequence order).

// tsconfig sets noUncheckedIndexedAccess, so every indexed read is
// `number | undefined` even inside a loop bounded by the array's own length.
// Reading out of range is a caller bug in every function here, and NaN
// propagates through the arithmetic below exactly as the undefined it stands in
// for would have — visibly, rather than silently becoming 0.
export function at(values: number[], index: number): number {
    return values[index] ?? Number.NaN;
}

// Trailing time-window rolling mean, matching pandas
// `series.rolling(window='Xms').mean()` on a millisecond datetime index:
// sample i averages all values with timestamp in (t_i - windowMs, t_i].
export function rollingMeanByTime(
    timestamps: number[],
    values: number[],
    windowMs: number,
): number[] {
    const out = new Array<number>(values.length);
    let start = 0;
    let sum = 0;
    let count = 0;
    for (const [i, value] of values.entries()) {
        sum += value;
        count++;
        // Walk the trailing edge forward. A start index past the end of
        // `timestamps` ends the walk, matching the old comparison against
        // undefined, which was false for every operand.
        for (;;) {
            const oldest = timestamps[start];
            if (oldest === undefined || !(oldest <= at(timestamps, i) - windowMs)) break;
            sum -= at(values, start);
            count--;
            start++;
        }
        out[i] = count > 0 ? sum / count : value;
    }
    return out;
}

// Linear interpolation at x over sorted (xs, ys), matching np.interp's
// clamping behaviour outside the domain.
export function interpolateAt(x: number, xs: number[], ys: number[]): number {
    const firstX = xs[0];
    const lastX = xs[xs.length - 1];
    if (firstX === undefined || lastX === undefined) return 0;
    if (x <= firstX) return at(ys, 0);
    if (x >= lastX) return at(ys, ys.length - 1);
    let lo = 0;
    let hi = xs.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (at(xs, mid) <= x) lo = mid;
        else hi = mid;
    }
    const xLo = at(xs, lo);
    const t = (x - xLo) / (at(xs, hi) - xLo);
    const yLo = at(ys, lo);
    return yLo + t * (at(ys, hi) - yLo);
}

// Downsample to fixed time bins keeping the last sample per bin, matching
// pandas `resample('100ms').last().dropna()` with the bin's left edge as the
// resulting timestamp.
export function resampleLast<T extends { timestamp_ms: number }>(
    measurements: T[],
    binMs = 100,
): T[] {
    const bins = new Map<number, T>();
    for (const m of measurements) {
        const bin = Math.floor(m.timestamp_ms / binMs) * binMs;
        bins.set(bin, m); // measurements arrive time-sorted, so last write wins
    }
    return [...bins.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([bin, m]) => ({ ...m, timestamp_ms: bin }) as T);
}

// Pearson correlation coefficient, matching pandas DataFrame.corr().
export function pearson(xs: number[], ys: number[]): number {
    const n = Math.min(xs.length, ys.length);
    if (n < 2) return NaN;
    const meanX = xs.reduce((s, v) => s + v, 0) / n;
    const meanY = ys.reduce((s, v) => s + v, 0) / n;
    let cov = 0;
    let varX = 0;
    let varY = 0;
    // n is the shorter of the two lengths, so both reads are in range.
    for (let i = 0; i < n; i++) {
        const dx = at(xs, i) - meanX;
        const dy = at(ys, i) - meanY;
        cov += dx * dy;
        varX += dx * dx;
        varY += dy * dy;
    }
    if (varX === 0 || varY === 0) return NaN;
    return cov / Math.sqrt(varX * varY);
}

export function mean(values: number[]): number {
    return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}

// Sample standard deviation (ddof=1), matching pandas Series.std().
export function stddev(values: number[]): number {
    if (values.length < 2) return NaN;
    const m = mean(values);
    return Math.sqrt(values.reduce((s, v) => s + (v - m) * (v - m), 0) / (values.length - 1));
}

export function groupBy<T, K>(items: T[], keyFn: (item: T) => K): Map<K, T[]> {
    const groups = new Map<K, T[]>();
    for (const item of items) {
        const key = keyFn(item);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)?.push(item);
    }
    return groups;
}
