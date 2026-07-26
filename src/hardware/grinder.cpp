#include "grinder.h"
#include "../controllers/grind_events.h"
#include "../config/constants.h"
#if DEBUG_ENABLE_LOADCELL_MOCK
#include "mock_hx711_driver.h"
#endif

void Grinder::init(int pin) {
    motor_pin = pin;
    grinding = false;
    initialized = false;
    pulse_active = false;
    rmt_initialized = false;
    rmt_channel = nullptr;
    current_encoder = nullptr;
    motor_start_time = 0;
    continuous_symbol = {};
    pulse_done.store(false);

    // Initialize background indicator
    background_active = false;
    ui_event_callback = nullptr;

#if DEBUG_ENABLE_LOADCELL_MOCK
    initialized = true;
    return;
#endif

    // Initialize RMT for all motor control (both continuous and pulse)
    rmt_tx_channel_config_t tx_chan_config = {
        .gpio_num = (gpio_num_t)motor_pin,
        .clk_src = RMT_CLK_SRC_DEFAULT,
        .resolution_hz = 1000000, // 1MHz resolution = 1µs per tick
        .mem_block_symbols = 64,
        .trans_queue_depth = 4,
    };

    if (rmt_new_tx_channel(&tx_chan_config, &rmt_channel) == ESP_OK) {
        // Must be registered while the channel is still in the init state. Pulse completion
        // is reported by this callback so the control loop never has to poll the driver.
        rmt_tx_event_callbacks_t callbacks = {};
        callbacks.on_trans_done = &Grinder::on_rmt_trans_done;
        const esp_err_t callback_result =
            rmt_tx_register_event_callbacks(rmt_channel, &callbacks, this);
        if (callback_result != ESP_OK) {
            LOG_BLE("ERROR: Failed to register grinder RMT callbacks: %d\n", callback_result);
            rmt_del_channel(rmt_channel);
            rmt_channel = nullptr;
            return;
        }

        rmt_enable(rmt_channel);
        rmt_initialized = true;
        initialized = true;
    }
}

bool Grinder::on_rmt_trans_done(rmt_channel_handle_t,
                                const rmt_tx_done_event_data_t*,
                                void* user_ctx) {
    auto* grinder = static_cast<Grinder*>(user_ctx);
    if (grinder) {
        grinder->pulse_done.store(true);
    }

    return false; // No higher priority task woken
}

void Grinder::start() {
#if DEBUG_ENABLE_LOADCELL_MOCK
    if (!initialized) return;
    MockHX711Driver::notify_grinder_start();
    pulse_active = false;
    grinding = true;
    motor_start_time = millis();
    emit_background_change(true);
    return;
#endif
    if (!initialized || !rmt_initialized) return;

    // Reset any active pulse state when using continuous mode
    pulse_active = false;
    motor_start_time = millis();
    
    // Clean up any existing encoder
    if (current_encoder) {
        rmt_del_encoder(current_encoder);
        current_encoder = nullptr;
    }
    
    // Create copy encoder for raw symbol data
    rmt_copy_encoder_config_t encoder_config = {};
    
    if (rmt_new_copy_encoder(&encoder_config, &current_encoder) != ESP_OK) {
        return;
    }
    
    // Use RMT infinite loop for continuous grinding
    continuous_symbol = {};
    continuous_symbol.duration0 = RmtPulseTiming::MAX_PHASE_DURATION_US;
    continuous_symbol.level0 = 1;
    continuous_symbol.duration1 = 0;
    continuous_symbol.level1 = 0;

    rmt_transmit_config_t tx_config = {};
    tx_config.loop_count = -1; // Infinite loop
    tx_config.flags.eot_level = 0;
    
    const esp_err_t transmit_result =
        rmt_transmit(
            rmt_channel,
            current_encoder,
            &continuous_symbol,
            sizeof(continuous_symbol),
            &tx_config);
    if (transmit_result != ESP_OK) {
        LOG_BLE("ERROR: Failed to start grinder RMT transmission: %d\n", transmit_result);
        rmt_del_encoder(current_encoder);
        current_encoder = nullptr;
        return;
    }

    grinding = true;
    emit_background_change(true);
}

void Grinder::stop() {
#if DEBUG_ENABLE_LOADCELL_MOCK
    if (!initialized) return;
    MockHX711Driver::notify_grinder_stop();
    grinding = false;
    pulse_active = false;
    emit_background_change(false);
    return;
#endif
    if (!initialized || !rmt_initialized) return;
    
    // Stop RMT transmission (works for both infinite loop and finite pulses)
    rmt_disable(rmt_channel);
    rmt_enable(rmt_channel); // Re-enable for next operation
    
    // Clean up current encoder
    if (current_encoder) {
        rmt_del_encoder(current_encoder);
        current_encoder = nullptr;
    }
    
    grinding = false;
    pulse_active = false;
    emit_background_change(false);
}

bool Grinder::start_pulse_rmt(uint32_t duration_ms) {
#if DEBUG_ENABLE_LOADCELL_MOCK
    if (!initialized || duration_ms == 0) return false;
    MockHX711Driver::notify_pulse(duration_ms);
    pulse_active = true;
    grinding = true;
    motor_start_time = millis();
    emit_background_change(true);
    return true;
#endif
    if (!initialized || !rmt_initialized) return false;

    const uint64_t duration_us = static_cast<uint64_t>(duration_ms) * 1000ULL;
    const size_t symbol_count = RmtPulseTiming::required_symbol_count(duration_us);
    if (symbol_count == 0 || symbol_count > RMT_PULSE_SYMBOL_CAPACITY) {
        LOG_BLE(
            "ERROR: Grinder pulse duration %lums exceeds supported range (1-%lums)\n",
            static_cast<unsigned long>(duration_ms),
            static_cast<unsigned long>(GRIND_MOTOR_MAX_SUPPORTED_PULSE_MS));
        return false;
    }

    motor_start_time = millis();

    // Recycle finished transaction descriptors before queueing a new one. Stopping a
    // continuous grind leaves one behind, because rmt_disable() moves the interrupted
    // transaction to the complete queue without retiring it.
    rmt_tx_wait_all_done(rmt_channel, 0);

    // Clean up any existing encoder
    if (current_encoder) {
        rmt_del_encoder(current_encoder);
        current_encoder = nullptr;
    }

    // Create copy encoder for raw symbol data
    rmt_copy_encoder_config_t encoder_config = {};

    if (rmt_new_copy_encoder(&encoder_config, &current_encoder) != ESP_OK) {
        LOG_BLE("ERROR: Failed to create grinder RMT encoder\n");
        return false;
    }

    for (size_t index = 0; index < symbol_count; ++index) {
        const RmtPulseTiming::SymbolDurations durations =
            RmtPulseTiming::symbol_durations(duration_us, index);

        pulse_symbols[index] = {};
        pulse_symbols[index].level0 = 1;
        pulse_symbols[index].duration0 = durations.first_us;
        pulse_symbols[index].level1 = durations.second_us > 0 ? 1 : 0;
        pulse_symbols[index].duration1 = durations.second_us;
    }

    rmt_transmit_config_t tx_config = {};
    tx_config.loop_count = 0;
    tx_config.flags.eot_level = 0;

    pulse_done.store(false);

    const esp_err_t transmit_result =
        rmt_transmit(
            rmt_channel,
            current_encoder,
            pulse_symbols,
            symbol_count * sizeof(pulse_symbols[0]),
            &tx_config);
    if (transmit_result != ESP_OK) {
        LOG_BLE("ERROR: Failed to start %lums grinder pulse: %d\n",
                static_cast<unsigned long>(duration_ms), transmit_result);
        rmt_del_encoder(current_encoder);
        current_encoder = nullptr;
        return false;
    }

    pulse_active = true;
    grinding = true;
    emit_background_change(true);
    return true;
}

bool Grinder::is_pulse_complete() {
#if DEBUG_ENABLE_LOADCELL_MOCK
    if (!pulse_active) return true;
    if (!MockHX711Driver::is_pulse_active()) {
        pulse_active = false;
        grinding = false;
        emit_background_change(false);
        return true;
    }
    return false;
#endif
    if (!pulse_active) return true;

    // Reported by the RMT transmit-done ISR. Polling rmt_tx_wait_all_done() here instead
    // would log a driver error on every unfinished poll.
    if (!pulse_done.load()) {
        return false;
    }

    pulse_active = false;
    grinding = false;
    emit_background_change(false);
    return true;
}

bool Grinder::is_motor_settled() const {
    // Return true if sufficient time has passed since motor start
    if (motor_start_time == 0) {
        return false;  // Motor has never started
    }
    return (millis() - motor_start_time) >= HW_GRINDER_SETTLING_TIME_MS;
}

void Grinder::set_ui_event_callback(const std::function<void(const GrindEventData&)>& callback) {
    ui_event_callback = callback;
}

void Grinder::emit_background_change(bool active) {
    if (background_active == active) {
        return; // No change
    }
    
    background_active = active;
    
    if (ui_event_callback) {
        // Properly initialize all required fields to prevent null pointer crashes
        GrindEventData event_data = {};
        event_data.event = UIGrindEvent::BACKGROUND_CHANGE;
        event_data.phase = GrindPhase::IDLE;  // Safe default
        event_data.current_weight = 0.0f;
        event_data.progress_percent = 0;
        event_data.phase_display_text = "BACKGROUND";  // Safe string for logging
        event_data.show_taring_text = false;
        event_data.background_active = active;
        
        ui_event_callback(event_data);
        
        LOG_BLE("[Grinder] Background change: %s\n", active ? "ACTIVE" : "INACTIVE");
    }
}
