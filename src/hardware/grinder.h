#pragma once
#include <Arduino.h>
#include <driver/rmt_tx.h>
#include <driver/rmt_encoder.h>
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

    static constexpr size_t RMT_PULSE_SYMBOL_CAPACITY =
        RmtPulseTiming::required_symbol_count(
            static_cast<uint64_t>(GRIND_AUTOTUNE_PRIMING_PULSE_MS) * 1000ULL);
    rmt_symbol_word_t pulse_symbols[RMT_PULSE_SYMBOL_CAPACITY];

    static_assert(
        RMT_PULSE_SYMBOL_CAPACITY <= 64,
        "Pulse payload must fit in the configured RMT memory block");
    static_assert(
        (GRIND_AUTOTUNE_LATENCY_MAX_MS + GRIND_MOTOR_MAX_PULSE_DURATION_MS) * 1000.0f <=
            RMT_PULSE_SYMBOL_CAPACITY * RmtPulseTiming::MAX_SYMBOL_DURATION_US,
        "Correction pulse range exceeds the Grinder RMT payload capacity");

    // Motor settling tracking
    unsigned long motor_start_time;

    // Background indicator state (always compiled in)
    bool background_active;
    std::function<void(const GrindEventData&)> ui_event_callback;

    void emit_background_change(bool active);

public:
    void init(int pin);
    void start();
    void stop();
    
    // RMT-based precise pulse control
    void start_pulse_rmt(uint32_t duration_ms);
    bool is_pulse_complete();
    
    bool is_grinding() const { return grinding; }
    bool is_initialized() const { return initialized; }
    bool is_motor_settled() const;

    // Background indicator setup (always compiled in)
    void set_ui_event_callback(const std::function<void(const GrindEventData&)>& callback);
};
