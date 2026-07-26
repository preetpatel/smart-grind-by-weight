#pragma once

#include <Arduino.h>
#include "../config/constants.h"

/**
 * LoadCellNoiseMonitor - Rolling noise statistics for the weight display path
 *
 * CircularBufferMath already stores every raw ADC sample, so single-sample noise can be measured
 * straight off that ring. What it does not store is the *smoothed* series the UI actually renders
 * - get_smoothed_raw() recomputes that on demand and throws it away. This class keeps a rolling
 * window of those smoothed values so we can report how much the displayed weight actually wanders,
 * which is the number that decides how many decimals the display can honestly show.
 *
 * What is measured (and what is not):
 * The monitor is fed the smoothed value *before* get_display_raw() applies its deadband and
 * asymmetric IIR. That is deliberate. The deadband hides jitter without reducing it, so measuring
 * after it would flatter the result. The IIR is also stateful, and driving it from the sampling
 * task would both corrupt the real UI filter and race with Core 1.
 *
 * Threading:
 * Appended from the Core 0 sampling task, scanned from the Core 1 UI task. This is the same
 * single-producer pattern CircularBufferMath uses: a reader can at worst cross one sample boundary
 * mid-scan, which perturbs a 300-sample statistic by well under a percent. Readers snapshot the
 * ring indices up front so the indexing stays self-consistent.
 *
 * Memory:
 * Values only, no per-sample timestamps - the sample rate is tracked separately with a small
 * bucket estimator instead. At the default 10 SPS / 30 s window that is 300 * 4 = 1.2 KB of static
 * DRAM, versus the 2.4 KB a parallel timestamp ring would have cost.
 */
class LoadCellNoiseMonitor {
public:
    struct RawStats {
        float    std_dev_raw;    // Standard deviation of the smoothed series, ADC counts
        int32_t  range_raw;      // Peak-to-peak of the smoothed series, ADC counts
        uint16_t sample_count;   // Samples the statistics were computed over
        float    measured_sps;   // Observed sample rate, may differ from HW_LOADCELL_SAMPLE_RATE_SPS
        bool     valid;          // False until enough samples have accumulated
    };

    // Window length in samples. Derived from the nominal ADC rate: if the hardware actually runs
    // faster or slower the ring still holds this many samples, it just spans less or more wall
    // time - which is why measured_sps is reported alongside.
    static constexpr uint16_t CAPACITY =
        (SYS_NOISE_MONITOR_WINDOW_MS * HW_LOADCELL_SAMPLE_RATE_SPS) / 1000;

    LoadCellNoiseMonitor();

    // Core 0: append one smoothed sample.
    void add_sample(int32_t smoothed_raw, uint32_t timestamp_ms);

    // Core 1: compute statistics over the current window.
    RawStats get_stats() const;

    // Drop all history. Called when the underlying sample buffer is cleared (tare, calibration)
    // so stale pre-tare values cannot leak into the statistics.
    void clear();

    uint16_t get_sample_count() const { return sample_count_; }

private:
    int32_t  values_[CAPACITY];
    uint16_t write_index_;
    uint16_t sample_count_;

    // Sample rate estimator - one-second buckets, exponentially smoothed.
    uint32_t rate_bucket_start_ms_;
    uint16_t rate_bucket_samples_;
    float    measured_sps_;
};
