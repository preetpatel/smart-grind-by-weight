#pragma once

//==============================================================================
// GRIND CONTROL CONFIGURATION
//==============================================================================
// This file contains all grind control related configuration constants
// including timing parameters, accuracy settings, flow detection, and
// pulse control algorithms.

//------------------------------------------------------------------------------
// PRIMING
//------------------------------------------------------------------------------
// Every weight-mode grind opens by running a small amount through the burrs to
// saturate them, which is what makes the latency detection honest. That run is
// the PRIME DOSE, and it happens either way - the only choice is what becomes
// of it. Hence Keep or Discard rather than the old Prime/Purge pair, which named
// one option after the thing both options do.
//
// The stored values are unchanged (0 = keep, 1 = discard) and so are the NVS
// keys, so existing grinders keep their setting across this rename.
enum class PrimeDoseMode {
    KEEP = 0,     // The prime dose lands in the cup; grinding continues immediately
    DISCARD = 1   // Pause after priming so the stale grounds can be tipped out
};

// Grinder saturation defaults and ranges
#define GRIND_PRIME_MODE_DEFAULT static_cast<int>(PrimeDoseMode::DISCARD)
#define GRIND_PRIME_AMOUNT_DEFAULT_G 1.0f
#define GRIND_PRIME_AMOUNT_MIN_G 0.1f
#define GRIND_PRIME_AMOUNT_MAX_G 2.5f

// Grind freshness tracking
#define GRIND_FRESHNESS_DEFAULT_HOURS 8.0f

//------------------------------------------------------------------------------
// GRIND CONTROL TUNING
//------------------------------------------------------------------------------
// Main accuracy and timeout settings
#define GRIND_ACCURACY_TOLERANCE_G 0.03f                                  // Final target accuracy tolerance
#define GRIND_TIMEOUT_SEC 60                                              // Maximum time for grind operation
#define GRIND_MAX_PULSE_ATTEMPTS 10                                       // Maximum pulse corrections before stopping

// Flow rate detection
#define GRIND_FLOW_DETECTION_THRESHOLD_GPS 0.5f                           // Minimum coffee flow rate to establish first grinds reachinig the cup = latency

// Undershoot strategy - determine when to stop grinding during the predictive phase
#define GRIND_UNDERSHOOT_TARGET_G 1.0f                                    // Default conservative undershoot target
#define GRIND_LATENCY_TO_COAST_RATIO 1.0f                                 // Ratio of expected coast time to measured latency (e.g., 0.8 = 80%)

// Prime phase behavior
#define GRIND_PRIME_TARGET_WEIGHT_G 1.0f                                   // Amount of coffee delivered during chute priming
#define GRIND_PRIME_MAX_DURATION_MS 5000                                   // Safety timeout for chute priming run
#define GRIND_PRIME_COAST_COMPENSATION_MS 300.0f                           // Grounds keep arriving roughly this long after the prime motor stops (measured ~380-410ms on logged sessions; kept conservative so the purge never under-delivers). The stop threshold is lowered by flow * this time so the configured amount is what actually lands, not what triggers the stop.

//------------------------------------------------------------------------------
// SCALE CALIBRATION AND SETTLING
//------------------------------------------------------------------------------
// Tare and settling behavior  
#define GRIND_SCALE_SETTLING_TOLERANCE_G 0.010f                           // Maximum standard deviation for settled reading. Used to determine if scale is settled. Increase value if you have a noisy load cell.

//------------------------------------------------------------------------------
// TIME MODE PULSE SETTINGS
//------------------------------------------------------------------------------
#define GRIND_TIME_PULSE_DURATION_MS 100                                        // Duration of additional pulses in time mode (milliseconds)



//------------------------------------------------------------------------------
// FLOW RATE PARAMETERS
//------------------------------------------------------------------------------
#define GRIND_FLOW_RATE_MIN_SANE_GPS 1.0f                                         // Minimum reasonable flow rate
#define GRIND_FLOW_RATE_MAX_SANE_GPS 3.0f                                         // Maximum reasonable steady-state flow rate
#define GRIND_PULSE_FLOW_RATE_FALLBACK_GPS 1.5f                                   // Fallback pulse flow rate when measured rate is invalid or too low
#define GRIND_PULSE_FLOW_MAX_SANE_GPS 4.0f                                        // Ceiling for EFFECTIVE pulse flow (yield incl. spin-down coast / productive ms). Legitimately exceeds the steady-state max - logged pulses ran up to ~1.4x steady flow - so pulse measurements and the seeded estimate clamp here, not at GRIND_FLOW_RATE_MAX_SANE_GPS

// Cross-session pulse gain learning. The first pulse of a session used to rely on
// the steady-state 95th-percentile flow alone, which under-predicts pulse yield
// (spin-down coast is unmodeled) - every logged first pulse over-delivered by
// 8-40%. The gain is the dimensionless ratio (effective pulse flow / steady-state
// estimate), learned as an EWMA and persisted to NVS ("pulse_gain"), so it
// survives bean changes (which shift absolute flow but not the ratio) and seeds
// the first pulse of every grind.
#define GRIND_PULSE_GAIN_DEFAULT 1.0f                                             // No correction until measurements arrive
#define GRIND_PULSE_GAIN_EWMA_ALPHA 0.2f                                          // Blend weight per accepted measurement (~5-grind memory; one outlier moves the estimate at most 20% of its clamped deviation)
#define GRIND_PULSE_GAIN_MIN 0.5f                                                 // Sample and estimate clamp - bounds outlier influence
#define GRIND_PULSE_GAIN_MAX 2.0f

//------------------------------------------------------------------------------
// TIMING CONSTRAINTS (Hardware-dependent)
//------------------------------------------------------------------------------
// Motor response latency - runtime configurable via auto-tune
#define GRIND_MOTOR_RESPONSE_LATENCY_DEFAULT_MS 50.0f                             // Safe default motor response latency
#define GRIND_MOTOR_MAX_PULSE_DURATION_MS 250.0f                                  // Maximum pulse duration above latency (latency + GRIND_MOTOR_MAX_PULSE_DURATION_MS)
#define GRIND_MOTOR_TEST_PULSE_MS 1000                                            // Menu motor test pulse length
#define GRIND_MOTOR_MAX_SUPPORTED_PULSE_MS 1000                                   // Longest pulse the RMT payload can hold (see Grinder static_asserts)

// Motor timing
#define GRIND_MOTOR_SETTLING_TIME_MS 200                                          // Motor vibration settling time

// Mechanical instability detection
#define GRIND_MECHANICAL_DROP_THRESHOLD_G 0.4f                                    // Weight drop considered mechanical instability
#define GRIND_MECHANICAL_EVENT_COOLDOWN_MS 200                                    // Minimum time between detecting drops
#define GRIND_MECHANICAL_EVENT_REQUIRED_COUNT 3                                   // Events required to flag diagnostic

// Scale settling timing
#define GRIND_SCALE_PRECISION_SETTLING_TIME_MS 500                                // High-precision settling time
#define GRIND_SCALE_SETTLING_TIMEOUT_MS 10000                                     // Maximum time to wait for settling

// Tare and calibration timing (hardware sample rate dependent)
#define GRIND_TARE_SAMPLE_WINDOW_MS 500                                           // Time window for tare sampling
#define GRIND_TARE_TIMEOUT_MS 3000                                                // Maximum tare completion time
#define GRIND_CALIBRATION_SAMPLE_WINDOW_MS 800                                    // Time window for calibration sampling  
#define GRIND_CALIBRATION_TIMEOUT_MS 2000                                         // Maximum calibration completion time

// Calculated sample counts based on hardware rate
#define GRIND_TARE_SAMPLE_COUNT (GRIND_TARE_SAMPLE_WINDOW_MS / HW_LOADCELL_SAMPLE_INTERVAL_MS)
#define GRIND_CALIBRATION_SAMPLE_COUNT (GRIND_CALIBRATION_SAMPLE_WINDOW_MS / HW_LOADCELL_SAMPLE_INTERVAL_MS)

//------------------------------------------------------------------------------
// MOTOR RESPONSE AUTO-TUNE ALGORITHM
//------------------------------------------------------------------------------
#define GRIND_AUTOTUNE_LATENCY_MIN_MS 30.0f                                       // Lower search bound for latency
#define GRIND_AUTOTUNE_LATENCY_MAX_MS 300.0f                                      // Upper search bound for latency
#define GRIND_AUTOTUNE_PRIMING_PULSE_MS 1000                                      // Initial chute priming pulse
#define GRIND_AUTOTUNE_TARGET_ACCURACY_MS 5.0f                                    // Target resolution
#define GRIND_AUTOTUNE_SUCCESS_RATE 0.80f                                         // 80% success threshold (4/5 pulses)
#define GRIND_AUTOTUNE_VERIFICATION_PULSES 5                                      // Verification attempts per candidate
#define GRIND_AUTOTUNE_MAX_ITERATIONS 50                                          // Hard stop safety limit
#define GRIND_AUTOTUNE_COLLECTION_DELAY_MS 1500                                   // Minimum wait after pulse for grounds to drop
#define GRIND_AUTOTUNE_SETTLING_TIMEOUT_MS 5000                                   // Max wait per pulse for scale settling
#define GRIND_AUTOTUNE_WEIGHT_THRESHOLD_G GRIND_SCALE_SETTLING_TOLERANCE_G        // 0.010g detection threshold
