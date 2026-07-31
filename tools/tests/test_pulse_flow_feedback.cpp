#include "controllers/pulse_flow_feedback.h"

#include <cassert>
#include <cmath>

namespace {

constexpr float kMinSaneGps = 1.0f;
constexpr float kMaxSaneGps = 3.0f;

bool near(float a, float b, float tol = 0.01f) {
    return std::fabs(a - b) <= tol;
}

}  // namespace

int main() {
    float flow = -1.0f;

    // Real pulse from logged session 7: 174.8ms commanded, 45ms latency,
    // 0.334g delivered -> 2.57g/s, well above the 2.07g/s the model assumed.
    assert(PulseFlowFeedback::measured_flow_from_pulse(
        0.334f, 174.8f, 45.0f, kMinSaneGps, kMaxSaneGps, &flow));
    assert(near(flow, 2.573f));

    // Real pulse from logged session 8: 163.2ms, 46ms latency, 0.265g -> 2.26g/s.
    assert(PulseFlowFeedback::measured_flow_from_pulse(
        0.265f, 163.2f, 46.0f, kMinSaneGps, kMaxSaneGps, &flow));
    assert(near(flow, 2.261f));

    // No productive duration: pulse no longer than latency is not an observation.
    flow = -1.0f;
    assert(!PulseFlowFeedback::measured_flow_from_pulse(
        0.1f, 45.0f, 45.0f, kMinSaneGps, kMaxSaneGps, &flow));
    assert(!PulseFlowFeedback::measured_flow_from_pulse(
        0.1f, 30.0f, 45.0f, kMinSaneGps, kMaxSaneGps, &flow));
    assert(flow == -1.0f);

    // Near-zero yield (settling noise) implies an absurdly low rate: rejected.
    assert(!PulseFlowFeedback::measured_flow_from_pulse(
        0.005f, 145.0f, 45.0f, kMinSaneGps, kMaxSaneGps, &flow));

    // Negative yield (scale bumped between checkpoints): rejected.
    assert(!PulseFlowFeedback::measured_flow_from_pulse(
        -0.05f, 145.0f, 45.0f, kMinSaneGps, kMaxSaneGps, &flow));

    // Implausibly high yield (mid-grind disturbance): rejected.
    assert(!PulseFlowFeedback::measured_flow_from_pulse(
        1.5f, 145.0f, 45.0f, kMinSaneGps, kMaxSaneGps, &flow));

    // Boundary values are accepted (inclusive range).
    assert(PulseFlowFeedback::measured_flow_from_pulse(
        0.1f, 145.0f, 45.0f, kMinSaneGps, kMaxSaneGps, &flow));
    assert(near(flow, 1.0f));
    assert(PulseFlowFeedback::measured_flow_from_pulse(
        0.3f, 145.0f, 45.0f, kMinSaneGps, kMaxSaneGps, &flow));
    assert(near(flow, 3.0f));

    // --- Cross-session gain EWMA ---
    constexpr float kAlpha = 0.2f;
    constexpr float kMinGain = 0.5f;
    constexpr float kMaxGain = 2.0f;

    // Logged session 10: measured 2.73g/s against base 2.14g/s -> sample 1.276.
    // From the 1.0 default the estimate moves 20% of the way there.
    float gain = PulseFlowFeedback::updated_gain_ewma(
        1.0f, 2.73f, 2.14f, kAlpha, kMinGain, kMaxGain);
    assert(near(gain, 1.0f + 0.2f * (2.73f / 2.14f - 1.0f)));

    // A single absurd observation is clamped to kMaxGain BEFORE blending, so
    // from gain 1.25 it can move the estimate at most 0.2 * (2.0 - 1.25) = 0.15
    // regardless of how extreme the measurement was.
    float after_outlier = PulseFlowFeedback::updated_gain_ewma(
        1.25f, 100.0f, 2.0f, kAlpha, kMinGain, kMaxGain);
    assert(near(after_outlier, 1.25f + 0.2f * (2.0f - 1.25f)));

    // Convergence: repeated consistent samples approach the true ratio, and the
    // estimate never leaves [kMinGain, kMaxGain].
    gain = 1.0f;
    for (int i = 0; i < 30; i++) {
        gain = PulseFlowFeedback::updated_gain_ewma(
            gain, 2.6f, 2.1f, kAlpha, kMinGain, kMaxGain);
        assert(gain >= kMinGain && gain <= kMaxGain);
    }
    assert(near(gain, 2.6f / 2.1f, 0.02f));

    // An outlier's influence decays geometrically once normal samples resume.
    float disturbed = PulseFlowFeedback::updated_gain_ewma(
        gain, 100.0f, 2.0f, kAlpha, kMinGain, kMaxGain);
    for (int i = 0; i < 15; i++) {
        disturbed = PulseFlowFeedback::updated_gain_ewma(
            disturbed, 2.6f, 2.1f, kAlpha, kMinGain, kMaxGain);
    }
    assert(near(disturbed, 2.6f / 2.1f, 0.03f));

    // Unusable base leaves the estimate untouched.
    assert(PulseFlowFeedback::updated_gain_ewma(
        1.3f, 2.5f, 0.0f, kAlpha, kMinGain, kMaxGain) == 1.3f);
    assert(PulseFlowFeedback::updated_gain_ewma(
        1.3f, 2.5f, -1.0f, kAlpha, kMinGain, kMaxGain) == 1.3f);

    return 0;
}
