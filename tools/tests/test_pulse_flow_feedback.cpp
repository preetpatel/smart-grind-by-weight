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

    return 0;
}
