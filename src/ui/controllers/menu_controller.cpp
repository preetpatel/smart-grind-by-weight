#include "menu_controller.h"

#include <Arduino.h>
#include <LittleFS.h>
#include <Preferences.h>
#include <esp_err.h>
#include <esp_system.h>
#include <nvs_flash.h>
#include <cstdint>
#include "../../config/constants.h"
#include "../../controllers/grind_controller.h"
#include "../../controllers/grind_mode_traits.h"
#include "../../logging/grind_logging.h"
#include "../../system/diagnostics_controller.h"
#include "../../system/statistics_manager.h"
#include "../../system/time_sync.h"
#include "../../system/wifi_service.h"
#include "../../system/cloud_sync.h"
#include "../components/blocking_overlay.h"
#include "../components/ui_operations.h"
#include "../event_bridge_lvgl.h"
#include "../ui_helpers.h"
#include "../ui_manager.h"
#include "../screens/menu_screen.h"

MenuUIController::MenuUIController(UIManager* manager)
    : ui_manager_(manager) {}

void MenuUIController::register_events() {
    if (!ui_manager_) {
        return;
    }

    using ET = EventBridgeLVGL::EventType;

    EventBridgeLVGL::register_handler(ET::MENU_CALIBRATE, [this](lv_event_t*) { handle_calibrate(); });
    EventBridgeLVGL::register_handler(ET::MENU_RESET, [this](lv_event_t*) { handle_reset(); });
    EventBridgeLVGL::register_handler(ET::MENU_PURGE, [this](lv_event_t*) { handle_purge(); });
    EventBridgeLVGL::register_handler(ET::MENU_MOTOR_TEST, [this](lv_event_t*) { handle_motor_test(); });
    EventBridgeLVGL::register_handler(ET::MENU_SCALE_OPEN, [this](lv_event_t*) { handle_scale_open(); });
    EventBridgeLVGL::register_handler(ET::MENU_SCALE_TARE, [this](lv_event_t*) { handle_scale_tare(); });
    EventBridgeLVGL::register_handler(ET::MENU_AUTOTUNE, [this](lv_event_t*) { handle_autotune(); });
    EventBridgeLVGL::register_handler(ET::MENU_DIAGNOSTIC_RESET, [this](lv_event_t*) { handle_diagnostics_reset(); });
    EventBridgeLVGL::register_handler(ET::MENU_NOISE_TEST, [this](lv_event_t*) { handle_noise_test(); });
    EventBridgeLVGL::register_handler(ET::MENU_BACK, [this](lv_event_t*) { handle_back(); });
    EventBridgeLVGL::register_handler(ET::MENU_REFRESH_STATS, [this](lv_event_t*) { handle_refresh_stats(); });

    EventBridgeLVGL::register_handler(ET::BLE_TOGGLE, [this](lv_event_t*) { handle_ble_toggle(); });
    EventBridgeLVGL::register_handler(ET::BLE_STARTUP_TOGGLE, [this](lv_event_t*) { handle_ble_startup_toggle(); });
    EventBridgeLVGL::register_handler(ET::WIFI_TOGGLE, [this](lv_event_t*) { handle_wifi_toggle(); });
    EventBridgeLVGL::register_handler(ET::WIFI_FORGET, [this](lv_event_t*) { handle_wifi_forget(); });
    EventBridgeLVGL::register_handler(ET::CLOUD_SYNC_TOGGLE, [this](lv_event_t*) { handle_cloud_sync_toggle(); });
    EventBridgeLVGL::register_handler(ET::CLOUD_SYNC_FORGET, [this](lv_event_t*) { handle_cloud_sync_forget(); });
    EventBridgeLVGL::register_handler(ET::LOGGING_TOGGLE, [this](lv_event_t*) { handle_logging_toggle(); });

    EventBridgeLVGL::register_handler(ET::GRIND_MODE_SWIPE_TOGGLE, [this](lv_event_t*) { handle_grind_mode_swipe_toggle(); });
    EventBridgeLVGL::register_handler(ET::GRIND_MODE_RADIO_BUTTON, [this](lv_event_t*) { handle_grind_mode_radio_button(); });
    EventBridgeLVGL::register_handler(ET::AUTO_START_TOGGLE, [this](lv_event_t*) { handle_auto_start_toggle(); });
    EventBridgeLVGL::register_handler(ET::AUTO_RETURN_TOGGLE, [this](lv_event_t*) { handle_auto_return_toggle(); });
    EventBridgeLVGL::register_handler(ET::GRINDER_PURGE_MODE_RADIO_BUTTON, [this](lv_event_t*) { handle_grinder_purge_mode_radio_button(); });
    EventBridgeLVGL::register_handler(ET::GRINDER_PURGE_AMOUNT_SLIDER, [this](lv_event_t*) { handle_grinder_purge_amount_slider(); });
    EventBridgeLVGL::register_handler(ET::GRINDER_PURGE_AMOUNT_SLIDER_RELEASED, [this](lv_event_t*) { handle_grinder_purge_amount_slider_released(); });
    EventBridgeLVGL::register_handler(ET::GRIND_FRESHNESS_HOURS_SLIDER, [this](lv_event_t*) { handle_grind_freshness_hours_slider(); });
    EventBridgeLVGL::register_handler(ET::GRIND_FRESHNESS_HOURS_SLIDER_RELEASED, [this](lv_event_t*) { handle_grind_freshness_hours_slider_released(); });

    EventBridgeLVGL::register_handler(ET::BRIGHTNESS_NORMAL_SLIDER, [this](lv_event_t*) { handle_brightness_normal_slider(); });
    EventBridgeLVGL::register_handler(ET::BRIGHTNESS_NORMAL_SLIDER_RELEASED, [this](lv_event_t*) { handle_brightness_normal_slider_released(); });
    EventBridgeLVGL::register_handler(ET::BRIGHTNESS_SCREENSAVER_SLIDER, [this](lv_event_t*) { handle_brightness_screensaver_slider(); });
    EventBridgeLVGL::register_handler(ET::BRIGHTNESS_SCREENSAVER_SLIDER_RELEASED, [this](lv_event_t*) { handle_brightness_screensaver_slider_released(); });
    EventBridgeLVGL::register_handler(ET::CLOCK_24H_TOGGLE, [this](lv_event_t*) { handle_clock_24h_toggle(); });

    // Note: Event registration for menu widgets is done in the page creation functions
    // (menu_screen.cpp) because those widgets do not exist yet when this runs. The menu is
    // built on first MenuScreen::create() and then only hidden/shown, never destroyed.
    // Attempting to register events here would fail silently.
}

void MenuUIController::update() {
    if (!ui_manager_) {
        return;
    }

    auto& menu_screen = ui_manager_->menu_screen;
    WeightSensor* sensor = ui_manager_->hardware_manager->get_weight_sensor();

    // The live scale readout is the only menu content that needs frame-rate updates. It is a
    // single label and now only reallocates when the displayed value actually changes.
    if (menu_screen.is_scale_page_active()) {
        menu_screen.update_scale_weight(sensor ? sensor->get_display_weight() : 0.0f);
    }

    // Everything below is slow-moving status text. Running it every UI frame rewrote roughly
    // ten labels per frame - each an unconditional free/malloc of the label text plus a
    // deferred-refresh hook allocation - on pages that were usually not even on screen.
    // Refresh only the visible page, at a rate a human can actually read.
    uint32_t now = millis();
    if (now - last_status_refresh_ms_ < SYS_MENU_STATUS_REFRESH_INTERVAL_MS) {
        return;
    }
    last_status_refresh_ms_ = now;

    // Advanced regardless of which page is showing, so navigating away mid-capture does not
    // abandon it. The start time is absolute, so a capture that spans a period where update() was
    // not running simply completes the moment it resumes.
    update_noise_capture();

    if (menu_screen.is_info_page_active()) {
        menu_screen.update_info(sensor, now, ESP.getFreeHeap());
    }
    if (menu_screen.is_diagnostics_page_active()) {
        menu_screen.update_diagnostics(sensor);
        menu_screen.update_noise_capture(noise_capture_);
    }
    if (menu_screen.is_bluetooth_page_active()) {
        menu_screen.update_ble_status();
    }
    if (menu_screen.is_wifi_page_active()) {
        menu_screen.update_wifi_status();
    }
    if (menu_screen.is_cloud_sync_page_active()) {
        menu_screen.update_cloud_sync_status();
    }
}

void MenuUIController::handle_calibrate() {
    if (ui_manager_) {
        ui_manager_->switch_to_state(UIState::CALIBRATION);
    }
}

void MenuUIController::handle_reset() {
    if (!ui_manager_) return;

    ui_manager_->show_confirmation(
        "FACTORY RESET",
        "This will reset all settings to factory defaults:\n\n"
        "• Profile weights\n"
        "• Calibration data\n"
        "• Grind history\n"
        "• Lifetime statistics\n\n"
        "This action cannot be undone.",
        "RESET",
        lv_color_hex(THEME_COLOR_ERROR),
        [this]() { perform_factory_reset(); },
        "CANCEL",
        [this]() { return_to_menu(); }
    );
}

void MenuUIController::handle_purge() {
    if (!ui_manager_) return;

    ui_manager_->show_confirmation(
        "PURGE LOGS",
        "This will remove all saved grind log files from flash.\n"
        "Lifetime statistics will be preserved."
        "\n\n"
        "This action cannot be undone.",
        "PURGE LOGS",
        lv_color_hex(THEME_COLOR_ERROR),
        [this]() { execute_purge_operation(); },
        "CANCEL",
        [this]() { return_to_menu(); }
    );
}

void MenuUIController::handle_motor_test() {
    if (!ui_manager_) return;

    ui_manager_->show_confirmation(
        "MOTOR TEST",
        "Motor will be engaged for 1 second."
        "\n\n"
        "Make sure grinder is safe to run.",
        "RUN",
        lv_color_hex(THEME_COLOR_SUCCESS),
        [this]() { run_motor_test(); },
        "CANCEL",
        [this]() { return_to_menu(); }
    );
}

void MenuUIController::handle_scale_open() {
    if (!ui_manager_) return;
    auto* hardware = ui_manager_->get_hardware_manager();
    if (!hardware) return;

    ui_manager_->menu_screen.reset_scale_display();

    UIOperations::execute_tare(hardware, [this]() {
        if (!ui_manager_) return;
        ui_manager_->refresh_auto_action_settings();

        auto* sensor = ui_manager_->hardware_manager->get_weight_sensor();
        float weight = sensor ? sensor->get_display_weight() : 0.0f;
        if (ui_manager_->menu_screen.is_scale_page_active()) {
            ui_manager_->menu_screen.update_scale_weight(weight);
        }
    },
    []() {
        BlockingOperationOverlay::getInstance().show_message(
            "TARE FAILED\nScale not settled", SYS_UI_ERROR_MESSAGE_DURATION_MS);
    });
}

void MenuUIController::handle_scale_tare() {
    if (!ui_manager_) return;
    auto* hardware = ui_manager_->get_hardware_manager();
    if (!hardware) return;

    UIOperations::execute_tare(hardware, [this]() {
        if (!ui_manager_) return;
        ui_manager_->refresh_auto_action_settings();

        auto* sensor = ui_manager_->hardware_manager->get_weight_sensor();
        float weight = sensor ? sensor->get_display_weight() : 0.0f;
        if (ui_manager_->menu_screen.is_scale_page_active()) {
            ui_manager_->menu_screen.update_scale_weight(weight);
        }
    },
    []() {
        BlockingOperationOverlay::getInstance().show_message(
            "TARE FAILED\nScale not settled", SYS_UI_ERROR_MESSAGE_DURATION_MS);
    });
}

void MenuUIController::handle_autotune() {
    if (!ui_manager_) return;

    // Show confirmation screen with setup instructions
    auto autotune_controller = ui_manager_->autotune_controller_.get();
    if (autotune_controller) {
        ui_manager_->show_confirmation(
            "Auto-Tune Setup",
            "Before starting:\n\n"
            "- Beans loaded\n"
            "- Cup on scale\n\n"
            "Process takes ~1 min.",
            "START",
            lv_color_hex(THEME_COLOR_ACCENT),
            [autotune_controller]() { autotune_controller->confirm_and_begin(); },
            "CANCEL",
            [this]() { return_to_menu(); }
        );
    }
}

void MenuUIController::handle_back() {
    if (!ui_manager_) return;
    ui_manager_->set_current_tab(3);
    ui_manager_->switch_to_state(UIState::READY);
}

void MenuUIController::handle_refresh_stats() {
    if (!ui_manager_) return;
    ui_manager_->menu_screen.refresh_statistics();
}

void MenuUIController::handle_diagnostics_reset() {
    if (!ui_manager_) return;

    ui_manager_->show_confirmation(
        "Reset Diagnostics",
        "This will clear all active diagnostic warnings.\n\nContinue?",
        "RESET",
        lv_color_hex(THEME_COLOR_WARNING),
        [this]() { perform_diagnostics_reset(); },
        "CANCEL",
        [this]() { return_to_menu(); }
    );
}

void MenuUIController::handle_noise_test() {
    if (!ui_manager_) return;

    // Ignore a second press while one is already running rather than restarting the clock - the
    // button is disabled during a capture, so this only guards against a queued double tap.
    if (noise_capture_.state == NoiseCaptureView::State::CAPTURING) {
        return;
    }

    noise_capture_start_ms_ = millis();
    noise_capture_.state = NoiseCaptureView::State::CAPTURING;
    noise_capture_.seconds_remaining = SYS_NOISE_CAPTURE_DURATION_MS / SYS_MS_PER_SECOND;
    noise_capture_.result = {};

    LOG_BLE("[%lums MENU] Noise capture started (%lums window)\n",
            millis(), (unsigned long)SYS_NOISE_CAPTURE_DURATION_MS);
}

void MenuUIController::update_noise_capture() {
    if (noise_capture_.state != NoiseCaptureView::State::CAPTURING) {
        return;
    }

    const uint32_t elapsed_ms = millis() - noise_capture_start_ms_;

    if (elapsed_ms < SYS_NOISE_CAPTURE_DURATION_MS) {
        // Round up so the countdown reads "30s" immediately after the press and only hits zero
        // when the window is genuinely complete.
        const uint32_t remaining_ms = SYS_NOISE_CAPTURE_DURATION_MS - elapsed_ms;
        noise_capture_.seconds_remaining =
            (remaining_ms + SYS_MS_PER_SECOND - 1) / SYS_MS_PER_SECOND;
        return;
    }

    // The rolling window now covers exactly the capture period, so the current stats are the
    // capture result. Freeze them so they survive the user picking the machine back up.
    auto* hardware = ui_manager_ ? ui_manager_->get_hardware_manager() : nullptr;
    auto* sensor = hardware ? hardware->get_weight_sensor() : nullptr;

    noise_capture_.seconds_remaining = 0;
    noise_capture_.state = NoiseCaptureView::State::COMPLETE;
    noise_capture_.result = sensor ? sensor->get_noise_stats() : LoadCellNoiseStats{};

    LOG_BLE("[%lums MENU] Noise capture complete: sample sigma %.5fg (%ld ADC), sample p-p %.5fg, "
            "display sigma %.5fg, display p-p %.5fg, %.5f g/count, %.1f SPS, %u samples\n",
            millis(),
            noise_capture_.result.sample_std_dev_g,
            (long)noise_capture_.result.sample_std_dev_adc,
            noise_capture_.result.sample_range_g,
            noise_capture_.result.display_std_dev_g,
            noise_capture_.result.display_range_g,
            noise_capture_.result.grams_per_count,
            noise_capture_.result.measured_sps,
            (unsigned)noise_capture_.result.sample_count);
}

void MenuUIController::perform_diagnostics_reset() {
    if (!ui_manager_) return;

    auto* diagnostics = ui_manager_->diagnostics_controller_.get();
    if (diagnostics) {
        diagnostics->reset_diagnostic(DiagnosticCode::LOAD_CELL_NOISY_SUSTAINED);
        diagnostics->reset_diagnostic(DiagnosticCode::MECHANICAL_INSTABILITY);
        diagnostics->reset_noise_tracking();
    }

    auto* grind_controller = ui_manager_->get_grind_controller();
    if (grind_controller) {
        grind_controller->reset_mechanical_anomaly_count();
    }

    auto* hardware = ui_manager_->get_hardware_manager();
    auto* sensor = hardware ? hardware->get_weight_sensor() : nullptr;
    if (sensor) {
        ui_manager_->menu_screen.update_diagnostics(sensor);
    }
}

void MenuUIController::handle_ble_toggle() {
    if (!ui_manager_ || !ui_manager_->bluetooth_manager) return;

    auto* ble = ui_manager_->bluetooth_manager;
    if (ble->is_enabled()) {
        ble->disable();
        LOG_DEBUG_PRINTLN("Bluetooth disabled by user");
        ui_manager_->menu_screen.update_ble_status();
        return;
    }

    auto completion = [this]() {
        ui_manager_->menu_screen.update_ble_status();
    };

    auto operation = [ble]() {
        ble->enable();
        LOG_DEBUG_PRINTLN("Bluetooth enabled by user");
    };

    auto& overlay = BlockingOperationOverlay::getInstance();
    overlay.show_and_execute(BlockingOperation::BLE_ENABLING, operation, completion);
}

void MenuUIController::handle_ble_startup_toggle() {
    if (!ui_manager_) return;

    auto* toggle = ui_manager_->menu_screen.get_ble_startup_toggle();
    if (!toggle) return;

    bool startup_enabled = lv_obj_has_state(toggle, LV_STATE_CHECKED);

    Preferences prefs;
    prefs.begin("bluetooth", false);
    prefs.putBool("startup", startup_enabled);
    prefs.end();

    LOG_DEBUG_PRINTLN(startup_enabled ? "Bluetooth startup enabled" : "Bluetooth startup disabled");
}

void MenuUIController::handle_wifi_toggle() {
    if (!ui_manager_) return;

    auto* toggle = ui_manager_->menu_screen.get_wifi_toggle();
    if (!toggle) return;

    wifi_service.set_enabled(lv_obj_has_state(toggle, LV_STATE_CHECKED));
    ui_manager_->menu_screen.update_wifi_status();
}

void MenuUIController::handle_wifi_forget() {
    if (!ui_manager_) return;

    ui_manager_->show_confirmation(
        "FORGET NETWORK",
        "This will remove the stored WiFi credentials.\n\n"
        "The clock will only sync when a Bluetooth client connects.",
        "FORGET",
        lv_color_hex(THEME_COLOR_WARNING),
        [this]() {
            wifi_service.forget_credentials();
            return_to_menu();
        },
        "CANCEL",
        [this]() { return_to_menu(); }
    );
}

void MenuUIController::handle_cloud_sync_toggle() {
    if (!ui_manager_) return;

    auto* toggle = ui_manager_->menu_screen.get_cloud_toggle();
    if (!toggle) return;

    cloud_sync.set_enabled(lv_obj_has_state(toggle, LV_STATE_CHECKED));
    ui_manager_->menu_screen.update_cloud_sync_status();
}

void MenuUIController::handle_cloud_sync_forget() {
    if (!ui_manager_) return;

    ui_manager_->show_confirmation(
        "FORGET SYNC",
        "This will remove the cloud store keys from the grinder.\n\n"
        "Sessions already uploaded stay on the server.",
        "FORGET",
        lv_color_hex(THEME_COLOR_WARNING),
        [this]() {
            cloud_sync.forget_config();
            return_to_menu();
        },
        "CANCEL",
        [this]() { return_to_menu(); }
    );
}

void MenuUIController::handle_logging_toggle() {
    if (!ui_manager_) return;

    auto* toggle = ui_manager_->menu_screen.get_logging_toggle();
    if (!toggle) return;

    bool logging_enabled = lv_obj_has_state(toggle, LV_STATE_CHECKED);

    Preferences prefs;
    prefs.begin("logging", false);
    prefs.putBool("enabled", logging_enabled);
    prefs.end();

    LOG_DEBUG_PRINTLN(logging_enabled ? "Logging enabled" : "Logging disabled");
}

void MenuUIController::handle_grind_mode_swipe_toggle() {
    if (!ui_manager_) return;

    auto* toggle = ui_manager_->menu_screen.get_grind_mode_swipe_toggle();
    if (!toggle) return;

    bool swipe_enabled = lv_obj_has_state(toggle, LV_STATE_CHECKED);

    Preferences prefs;
    prefs.begin("swipe", false);
    prefs.putBool("enabled", swipe_enabled);
    prefs.end();

    LOG_DEBUG_PRINTLN(swipe_enabled ? "Grind mode swipe gestures enabled" : "Grind mode swipe gestures disabled");
}

void MenuUIController::handle_grind_mode_radio_button() {
    if (!ui_manager_ || !ui_manager_->profile_controller) return;

    lv_obj_t* radio_group = ui_manager_->menu_screen.get_grind_mode_radio_group();
    if (!radio_group) return;

    int selected_index = radio_button_group_get_selection(radio_group);
    if (selected_index < 0) return;

    GrindMode new_mode = (selected_index == 0) ? GrindMode::WEIGHT : GrindMode::TIME;
    ui_manager_->profile_controller->set_grind_mode(new_mode);
    ui_manager_->current_mode = new_mode;
    if (ui_manager_->ready_controller_) {
        ui_manager_->ready_controller_->refresh_profiles();
    }
    ui_manager_->edit_target = get_current_profile_target(*ui_manager_->profile_controller, new_mode);
    if (ui_manager_->state_machine->is_state(UIState::EDIT)) {
        if (ui_manager_->edit_controller_) {
            ui_manager_->edit_controller_->update_display();
        }
    }

    LOG_DEBUG_PRINTLN(selected_index == 0 ? "Grind mode set to WEIGHT via radio button" : "Grind mode set to TIME via radio button");
}

void MenuUIController::handle_auto_start_toggle() {
    if (!ui_manager_) return;

    auto* toggle = ui_manager_->menu_screen.get_auto_start_toggle();
    if (!toggle) return;

    bool enabled = lv_obj_has_state(toggle, LV_STATE_CHECKED);

    Preferences prefs;
    prefs.begin("autogrind", false);
    prefs.putBool("auto_start", enabled);
    prefs.end();

    if (ui_manager_) {
        ui_manager_->refresh_auto_action_settings();
    }

    LOG_DEBUG_PRINTLN(enabled ? "Auto-start on cup enabled" : "Auto-start on cup disabled");
}

void MenuUIController::handle_auto_return_toggle() {
    if (!ui_manager_) return;

    auto* toggle = ui_manager_->menu_screen.get_auto_return_toggle();
    if (!toggle) return;

    bool enabled = lv_obj_has_state(toggle, LV_STATE_CHECKED);

    Preferences prefs;
    prefs.begin("autogrind", false);
    prefs.putBool("auto_return", enabled);
    prefs.end();

    if (ui_manager_) {
        ui_manager_->refresh_auto_action_settings();
    }

    LOG_DEBUG_PRINTLN(enabled ? "Auto return on cup removal enabled" : "Auto return on cup removal disabled");
}

void MenuUIController::handle_grinder_purge_mode_radio_button() {
    if (!ui_manager_) return;

    auto* radio_group = ui_manager_->menu_screen.get_grinder_purge_mode_radio_group();
    if (!radio_group) return;

    int selected_index = radio_button_group_get_selection(radio_group);

    auto* hardware = ui_manager_->get_hardware_manager();
    Preferences* prefs = hardware ? hardware->get_preferences() : nullptr;
    if (prefs) {
        prefs->putInt(GrindController::PREF_KEY_GRINDER_MODE, selected_index);
    }

    LOG_DEBUG_PRINTLN(selected_index == 0 ? "Grinder purge mode: Prime (keep coffee)" : "Grinder purge mode: Purge (discard grinds)");
}

void MenuUIController::handle_grinder_purge_amount_slider() {
    if (!ui_manager_) return;

    auto* slider = ui_manager_->menu_screen.get_grinder_purge_amount_slider();
    if (!slider) return;

    int slider_value = lv_slider_get_value(slider);
    float amount_g = slider_value / MenuScreen::kPurgeSliderScale;
    if (amount_g < GRIND_PURGE_AMOUNT_MIN_G) amount_g = GRIND_PURGE_AMOUNT_MIN_G;
    if (amount_g > GRIND_PURGE_AMOUNT_MAX_G) amount_g = GRIND_PURGE_AMOUNT_MAX_G;

    // Update the label via MenuScreen method
    ui_manager_->menu_screen.update_grinder_purge_amount_label(amount_g);
}

void MenuUIController::handle_grinder_purge_amount_slider_released() {
    if (!ui_manager_) return;

    auto* slider = ui_manager_->menu_screen.get_grinder_purge_amount_slider();
    if (!slider) return;

    int slider_value = lv_slider_get_value(slider);
    float amount_g = slider_value / MenuScreen::kPurgeSliderScale;
    if (amount_g < GRIND_PURGE_AMOUNT_MIN_G) {
        amount_g = GRIND_PURGE_AMOUNT_MIN_G;
        lv_slider_set_value(slider, static_cast<int>(GRIND_PURGE_AMOUNT_MIN_G * MenuScreen::kPurgeSliderScale + 0.5f), LV_ANIM_OFF);
    } else if (amount_g > GRIND_PURGE_AMOUNT_MAX_G) {
        amount_g = GRIND_PURGE_AMOUNT_MAX_G;
        lv_slider_set_value(slider, static_cast<int>(GRIND_PURGE_AMOUNT_MAX_G * MenuScreen::kPurgeSliderScale + 0.5f), LV_ANIM_OFF);
    }

    auto* hardware = ui_manager_->get_hardware_manager();
    Preferences* prefs = hardware ? hardware->get_preferences() : nullptr;
    if (prefs) {
        prefs->putFloat(GrindController::PREF_KEY_GRINDER_AMOUNT_G, amount_g);
    }

    LOG_DEBUG_PRINT("Grinder purge amount set to: ");
    LOG_DEBUG_PRINT(amount_g);
    LOG_DEBUG_PRINTLN("g");

    ui_manager_->menu_screen.update_grinder_purge_amount_label(amount_g);
}

void MenuUIController::handle_grind_freshness_hours_slider() {
    if (!ui_manager_) return;

    auto* slider = ui_manager_->menu_screen.get_grind_freshness_hours_slider();
    if (!slider) return;

    // Map slider value to hours (discrete steps: 0.5, 1, 2, 3, 4, 8, 12, 24, 48)
    static const float freshness_steps[] = {0.5f, 1.0f, 2.0f, 3.0f, 4.0f, 8.0f, 12.0f, 24.0f, 48.0f};
    int slider_index = lv_slider_get_value(slider);
    if (slider_index < 0) slider_index = 0;
    if (slider_index > 8) slider_index = 8;
    float hours = freshness_steps[slider_index];

    // Update the label via MenuScreen method
    ui_manager_->menu_screen.update_grind_freshness_hours_label(hours);
}

void MenuUIController::handle_grind_freshness_hours_slider_released() {
    if (!ui_manager_) return;

    auto* slider = ui_manager_->menu_screen.get_grind_freshness_hours_slider();
    if (!slider) return;

    // Map slider value to hours (discrete steps: 0.5, 1, 2, 3, 4, 8, 12, 24, 48)
    static const float freshness_steps[] = {0.5f, 1.0f, 2.0f, 3.0f, 4.0f, 8.0f, 12.0f, 24.0f, 48.0f};
    int slider_index = lv_slider_get_value(slider);
    if (slider_index < 0) slider_index = 0;
    if (slider_index > 8) slider_index = 8;
    float hours = freshness_steps[slider_index];

    auto* hardware = ui_manager_->get_hardware_manager();
    Preferences* prefs = hardware ? hardware->get_preferences() : nullptr;
    if (prefs) {
        prefs->putFloat(GrindController::PREF_KEY_GRIND_FRESHNESS_HOURS, hours);
    }

    LOG_DEBUG_PRINT("Grind freshness hours set to: ");
    LOG_DEBUG_PRINT(hours);
    LOG_DEBUG_PRINTLN("h");

    ui_manager_->menu_screen.update_grind_freshness_hours_label(hours);
}

void MenuUIController::handle_brightness_normal_slider() {
    if (!ui_manager_) return;

    auto* slider = ui_manager_->menu_screen.get_brightness_normal_slider();
    if (!slider) return;

    int brightness_percent = lv_slider_get_value(slider);
    if (brightness_percent < HW_DISPLAY_MINIMAL_BRIGHTNESS_PERCENT) {
        brightness_percent = HW_DISPLAY_MINIMAL_BRIGHTNESS_PERCENT;
        lv_slider_set_value(slider, brightness_percent, LV_ANIM_OFF);
    }
    float brightness = brightness_percent / 100.0f;

    ui_manager_->get_hardware_manager()->get_display()->set_brightness(brightness);
    ui_manager_->menu_screen.update_brightness_labels(brightness_percent, -1);
    LOG_DEBUG_PRINTF("Normal brightness set to %d%% (%.2f)\n", brightness_percent, brightness);
}

void MenuUIController::handle_brightness_normal_slider_released() {
    auto* slider = ui_manager_->menu_screen.get_brightness_normal_slider();
    if (!slider) return;

    int brightness_percent = lv_slider_get_value(slider);
    if (brightness_percent < HW_DISPLAY_MINIMAL_BRIGHTNESS_PERCENT) {
        brightness_percent = HW_DISPLAY_MINIMAL_BRIGHTNESS_PERCENT;
        lv_slider_set_value(slider, brightness_percent, LV_ANIM_OFF);
    }
    float brightness = brightness_percent / 100.0f;

    Preferences prefs;
    prefs.begin("brightness", false);
    prefs.putFloat("normal", brightness);
    prefs.end();
}

void MenuUIController::handle_brightness_screensaver_slider() {
    if (!ui_manager_) return;

    auto* slider = ui_manager_->menu_screen.get_brightness_screensaver_slider();
    if (!slider) return;

    int brightness_percent = lv_slider_get_value(slider);
    if (brightness_percent < HW_DISPLAY_MINIMAL_BRIGHTNESS_PERCENT) {
        brightness_percent = HW_DISPLAY_MINIMAL_BRIGHTNESS_PERCENT;
        lv_slider_set_value(slider, brightness_percent, LV_ANIM_OFF);
    }
    float brightness = brightness_percent / 100.0f;

    ui_manager_->get_hardware_manager()->get_display()->set_brightness(brightness);
    ui_manager_->menu_screen.update_brightness_labels(-1, brightness_percent);
    LOG_DEBUG_PRINTF("Screensaver brightness set to %d%% (%.2f)\n", brightness_percent, brightness);
}

void MenuUIController::handle_brightness_screensaver_slider_released() {
    auto* slider = ui_manager_->menu_screen.get_brightness_screensaver_slider();
    if (!slider) return;

    int brightness_percent = lv_slider_get_value(slider);
    if (brightness_percent < HW_DISPLAY_MINIMAL_BRIGHTNESS_PERCENT) {
        brightness_percent = HW_DISPLAY_MINIMAL_BRIGHTNESS_PERCENT;
        lv_slider_set_value(slider, brightness_percent, LV_ANIM_OFF);
    }
    float brightness = brightness_percent / 100.0f;

    Preferences prefs;
    prefs.begin("brightness", false);
    prefs.putFloat("screensaver", brightness);
    prefs.end();

    float normal = get_normal_brightness();
    ui_manager_->get_hardware_manager()->get_display()->set_brightness(normal);
    LOG_DEBUG_PRINTF("Touch released - restored normal brightness to %.2f\n", normal);
}

void MenuUIController::handle_clock_24h_toggle() {
    if (!ui_manager_) return;

    auto* toggle = ui_manager_->menu_screen.get_clock_24h_toggle();
    if (!toggle) return;

    bool use_24h = lv_obj_has_state(toggle, LV_STATE_CHECKED);
    TimeSync::set_use_24h(use_24h);

    // The System Info page shows the same clock; refresh it so the change is
    // visible immediately rather than at the next status refresh tick.
    auto* sensor = ui_manager_->hardware_manager ? ui_manager_->hardware_manager->get_weight_sensor() : nullptr;
    if (ui_manager_->menu_screen.is_info_page_active()) {
        ui_manager_->menu_screen.update_info(sensor, millis(), ESP.getFreeHeap());
    }

    LOG_DEBUG_PRINTLN(use_24h ? "Clock set to 24-hour" : "Clock set to AM/PM");
}

void MenuUIController::perform_factory_reset() {
    if (!ui_manager_) return;

    LOG_DEBUG_PRINTLN("Factory reset: clearing NVS preferences and rebooting...");

    nvs_flash_deinit();
    esp_err_t erase_result = nvs_flash_erase();

    if (erase_result == ESP_OK) {
        LOG_DEBUG_PRINTLN("Factory reset: NVS erase successful. Restarting device...");
    } else {
        LOG_DEBUG_PRINTF("Factory reset: NVS erase failed (code %d). Forcing restart...\n",
                         static_cast<int>(erase_result));
    }

    delay(100);
    esp_restart();
}

void MenuUIController::execute_purge_operation() {
    if (!ui_manager_) return;

    auto completion = [this]() {
        return_to_menu();
        ui_manager_->menu_screen.refresh_statistics(false);
    };

    auto purge_task = []() {
        LOG_DEBUG_PRINTLN("\n=== PURGE GRIND LOGS INITIATED ===");
        extern GrindLogger grind_logger;
        bool success = grind_logger.clear_all_sessions_from_flash();
        if (success) {
            LOG_DEBUG_PRINTLN("Grind logs purged successfully - reinitializing logger...");
        } else {
            LOG_DEBUG_PRINTLN("ERROR: Failed to purge all grind log data!");
        }
    };

    auto& overlay = BlockingOperationOverlay::getInstance();
    overlay.show_and_execute(BlockingOperation::CUSTOM, purge_task, completion,
                             "PURGING LOGS...\nPlease wait");
}

void MenuUIController::run_motor_test() {
    if (!ui_manager_) return;

    auto* grinder = ui_manager_->get_hardware_manager()->get_grinder();
    if (!grinder) return;

    ui_manager_->set_background_active(true);

    if (!grinder->start_pulse_rmt(GRIND_MOTOR_TEST_PULSE_MS)) {
        LOG_BLE("ERROR: Motor test pulse rejected by grinder\n");
        ui_manager_->set_background_active(false);
        return_to_menu();
        return;
    }

    statistics_manager.update_motor_test(GRIND_MOTOR_TEST_PULSE_MS);

    stop_motor_timer();
    motor_timer_ = lv_timer_create(static_motor_timer_cb, 2000, this);
    if (motor_timer_) {
        lv_timer_set_user_data(motor_timer_, this);
    }
}

void MenuUIController::return_to_menu() {
    if (!ui_manager_) return;
    ui_manager_->set_current_tab(3);
    ui_manager_->switch_to_state(UIState::MENU);
}

float MenuUIController::get_normal_brightness() const {
    if (!ui_manager_ || !ui_manager_->hardware_manager) {
        return USER_SCREEN_BRIGHTNESS_NORMAL;
    }

    Preferences prefs;
    prefs.begin("brightness", true);
    float brightness = prefs.getFloat("normal", USER_SCREEN_BRIGHTNESS_NORMAL);
    prefs.end();

    if (brightness < 0.15f) {
        brightness = 0.15f;
    }
    return brightness;
}

float MenuUIController::get_screensaver_brightness() const {
    if (!ui_manager_ || !ui_manager_->hardware_manager) {
        return USER_SCREEN_BRIGHTNESS_DIMMED;
    }

    Preferences prefs;
    prefs.begin("brightness", true);
    float brightness = prefs.getFloat("screensaver", USER_SCREEN_BRIGHTNESS_DIMMED);
    prefs.end();

    if (brightness < 0.15f) {
        brightness = 0.15f;
    }
    return brightness;
}

void MenuUIController::stop_motor_timer() {
    if (motor_timer_) {
        lv_timer_del(motor_timer_);
        motor_timer_ = nullptr;
    }
}

void MenuUIController::motor_timer_cb(lv_timer_t* timer) {
    if (!ui_manager_) {
        return;
    }

    auto* grinder = ui_manager_->get_hardware_manager()->get_grinder();
    if (grinder && !grinder->is_pulse_complete()) {
        grinder->stop();
    }

    stop_motor_timer();
    ui_manager_->set_background_active(false);
    return_to_menu();
}

void MenuUIController::static_motor_timer_cb(lv_timer_t* timer) {
    if (!timer) {
        return;
    }
    auto* controller = static_cast<MenuUIController*>(lv_timer_get_user_data(timer));
    if (controller) {
        controller->motor_timer_cb(timer);
    }
}
