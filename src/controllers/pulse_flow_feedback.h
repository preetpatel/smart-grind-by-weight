#pragma once

// Closed-loop pulse flow estimation.
//
// The pulse duration model predicts delivered mass as
//     mass = flow * (duration - latency) / 1000
// using a flow rate sampled once at the end of the PREDICTIVE phase. Each
// completed pulse is a direct observation of the same quantity, so inverting
// the model over the measured yield gives a better estimate for the next
// pulse. Pure logic, host-testable (see tools/tests/test_pulse_flow_feedback.cpp).
namespace PulseFlowFeedback {

// Derives the flow rate (g/s) implied by a completed pulse. Returns false and
// leaves flow_out untouched when the observation is unusable: no productive
// duration, or an implied rate outside the caller's sane range (settling noise
// on a near-zero yield, a bumped scale, or a mid-pulse clog).
inline bool measured_flow_from_pulse(float delivered_g,
                                     float pulse_duration_ms,
                                     float motor_latency_ms,
                                     float min_sane_gps,
                                     float max_sane_gps,
                                     float* flow_out) {
    const float productive_ms = pulse_duration_ms - motor_latency_ms;
    if (productive_ms <= 0.0f) {
        return false;
    }

    const float flow_gps = (delivered_g / productive_ms) * 1000.0f;
    if (flow_gps < min_sane_gps || flow_gps > max_sane_gps) {
        return false;
    }

    *flow_out = flow_gps;
    return true;
}

// Folds one measured-vs-predicted flow observation into the cross-session pulse
// gain EWMA. The sample (measured / base) is clamped to [min_gain, max_gain]
// BEFORE blending, so a wild observation can shift the estimate by at most
// alpha * (clamp bound - current); the estimate itself stays inside the same
// bounds by induction. Returns the current gain unchanged when base is not a
// usable reference.
inline float updated_gain_ewma(float current_gain,
                               float measured_flow_gps,
                               float base_flow_gps,
                               float alpha,
                               float min_gain,
                               float max_gain) {
    if (base_flow_gps <= 0.0f) {
        return current_gain;
    }

    float sample = measured_flow_gps / base_flow_gps;
    if (sample < min_gain) sample = min_gain;
    if (sample > max_gain) sample = max_gain;

    return current_gain + alpha * (sample - current_gain);
}

}  // namespace PulseFlowFeedback
