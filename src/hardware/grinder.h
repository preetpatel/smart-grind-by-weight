#pragma once
#include <Arduino.h>
#include <driver/rmt_tx.h>
#include <driver/rmt_encoder.h>
#include <atomic>
#include <functional>
#include "../config/constants.h"
#include "rmt_pulse_timing.h"

// Forward declarations
struct GrindEventData;
enum class UIGrindEvent;

class Grinder {
private:
    int motor_pin;
    bool grinding;
    bool initialized;

    // RMT pulse control
    rmt_channel_handle_t rmt_channel;
    rmt_encoder_handle_t current_encoder;
    bool pulse_active;
    bool rmt_initialized;
    rmt_symbol_word_t continuous_symbol;

    // Set from the RMT transmit-done ISR, cleared before each pulse is queued.
    std::atomic<bool> pulse_done;

    static constexpr size_t RMT_PULSE_SYMBOL_CAPACITY =
        RmtPulseTiming::required_symbol_count(
            static_cast<uint64_t>(GRIND_MOTOR_MAX_SUPPORTED_PULSE_MS) * 1000ULL);
    rmt_symbol_word_t pulse_symbols[RMT_PULSE_SYMBOL_CAPACITY];

    static_assert(
        RMT_PULSE_SYMBOL_CAPACITY <= 64,
        "Pulse payload must fit in the configured RMT memory block");

    // Every caller of start_pulse_rmt() must fit the payload, otherwise its pulse would be
    // rejected at runtime instead of failing the build.
    static_assert(
        GRIND_AUTOTUNE_PRIMING_PULSE_MS <= GRIND_MOTOR_MAX_SUPPORTED_PULSE_MS,
        "Auto-tune priming pulse exceeds the Grinder RMT payload capacity");
    static_assert(
        GRIND_MOTOR_TEST_PULSE_MS <= GRIND_MOTOR_MAX_SUPPORTED_PULSE_MS,
        "Motor test pulse exceeds the Grinder RMT payload capacity");
    static_assert(
        GRIND_AUTOTUNE_LATENCY_MAX_MS + GRIND_MOTOR_MAX_PULSE_DURATION_MS <=
            (float)GRIND_MOTOR_MAX_SUPPORTED_PULSE_MS,
        "Correction pulse range exceeds the Grinder RMT payload capacity");
    static_assert(
        (uint64_t)GRIND_MOTOR_MAX_SUPPORTED_PULSE_MS * 1000ULL <=
            (uint64_t)RMT_PULSE_SYMBOL_CAPACITY * RmtPulseTiming::MAX_SYMBOL_DURATION_US,
        "Maximum supported pulse exceeds the Grinder RMT payload capacity");

    // Motor settling tracking
    unsigned long motor_start_time;

    // Background indicator state (always compiled in)
    bool background_active;
    std::function<void(const GrindEventData&)> ui_event_callback;

    void emit_background_change(bool active);

    static bool on_rmt_trans_done(rmt_channel_handle_t channel,
                                  const rmt_tx_done_event_data_t* event_data,
                                  void* user_ctx);

public:
    void init(int pin);
    void start();
    void stop();

    // RMT-based precise pulse control. Returns false if the pulse could not be started, in
    // which case the motor never runs and the caller must not treat it as delivered.
    bool start_pulse_rmt(uint32_t duration_ms);
    bool is_pulse_complete();
    
    bool is_grinding() const { return grinding; }
    bool is_initialized() const { return initialized; }
    bool is_motor_settled() const;

    // Background indicator setup (always compiled in)
    void set_ui_event_callback(const std::function<void(const GrindEventData&)>& callback);
};
