#include "load_cell_noise_monitor.h"

#include <math.h>

namespace {
// Bucket length for the sample rate estimator.
constexpr uint32_t kRateBucketMs = 1000;
// Weight given to the running average when folding in a new bucket.
constexpr float kRateSmoothing = 0.7f;
}  // namespace

LoadCellNoiseMonitor::LoadCellNoiseMonitor() {
    clear();
}

void LoadCellNoiseMonitor::clear() {
    write_index_ = 0;
    sample_count_ = 0;
    rate_bucket_start_ms_ = 0;
    rate_bucket_samples_ = 0;
    measured_sps_ = 0.0f;

    for (uint16_t i = 0; i < CAPACITY; i++) {
        values_[i] = 0;
    }
}

void LoadCellNoiseMonitor::add_sample(int32_t smoothed_raw, uint32_t timestamp_ms) {
    values_[write_index_] = smoothed_raw;
    write_index_ = (write_index_ + 1) % CAPACITY;

    if (sample_count_ < CAPACITY) {
        sample_count_++;
    }

    // Sample rate estimate. Counting into fixed buckets rather than storing a timestamp per sample
    // keeps the ring at one word per entry.
    if (rate_bucket_start_ms_ == 0) {
        rate_bucket_start_ms_ = timestamp_ms;
    }
    rate_bucket_samples_++;

    uint32_t elapsed_ms = timestamp_ms - rate_bucket_start_ms_;
    if (elapsed_ms >= kRateBucketMs) {
        float bucket_sps = (rate_bucket_samples_ * 1000.0f) / elapsed_ms;
        measured_sps_ = (measured_sps_ <= 0.0f)
                            ? bucket_sps
                            : (kRateSmoothing * measured_sps_ + (1.0f - kRateSmoothing) * bucket_sps);
        rate_bucket_start_ms_ = timestamp_ms;
        rate_bucket_samples_ = 0;
    }
}

LoadCellNoiseMonitor::RawStats LoadCellNoiseMonitor::get_stats() const {
    RawStats stats = {};
    stats.measured_sps = measured_sps_;

    // Snapshot the ring indices so the scan stays self-consistent even if Core 0 appends midway.
    const uint16_t count = sample_count_;
    const uint16_t write_index = write_index_;

    stats.sample_count = count;

    if (count < SYS_NOISE_MIN_SAMPLES_FOR_STATS) {
        stats.valid = false;
        return stats;
    }

    // Work in deltas from the newest sample rather than absolute counts. Raw values sit around
    // 7e6, so squaring them directly would overflow float precision and lose the very variation we
    // are trying to measure; the deltas are small enough that the sums stay exact in int64.
    const uint16_t newest_index = (write_index - 1 + CAPACITY) % CAPACITY;
    const int32_t baseline = values_[newest_index];

    int64_t sum_delta = 0;
    int64_t sum_delta_sq = 0;
    int32_t min_delta = 0;
    int32_t max_delta = 0;

    for (uint16_t i = 0; i < count; i++) {
        const uint16_t index = (write_index - 1 - i + CAPACITY) % CAPACITY;
        const int32_t delta = values_[index] - baseline;

        sum_delta += delta;
        sum_delta_sq += (int64_t)delta * (int64_t)delta;

        if (i == 0 || delta < min_delta) {
            min_delta = delta;
        }
        if (i == 0 || delta > max_delta) {
            max_delta = delta;
        }
    }

    stats.range_raw = max_delta - min_delta;

    // Sample variance from the raw sums. Done once at the end in double so the subtraction of two
    // large accumulators does not lose the result.
    const double n = (double)count;
    const double mean = (double)sum_delta / n;
    double variance = ((double)sum_delta_sq - (double)sum_delta * mean) / (n - 1.0);
    if (variance < 0.0) {
        variance = 0.0;  // Guard against a tiny negative from rounding when the signal is flat
    }

    stats.std_dev_raw = (float)sqrt(variance);
    stats.valid = true;
    return stats;
}
