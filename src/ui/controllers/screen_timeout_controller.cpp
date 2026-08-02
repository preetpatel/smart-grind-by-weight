#include "screen_timeout_controller.h"

#include <Arduino.h>

#include "../../config/constants.h"
#include "../../hardware/display_manager.h"
#include "../../hardware/hardware_manager.h"
#include "../../system/time_sync.h"
#include "../components/blocking_overlay.h"
#include "../ui_manager.h"

ScreenTimeoutController::ScreenTimeoutController(UIManager* manager)
    : ui_manager_(manager),
      last_weight_activity_ms_(0),
      screen_dimmed_(false),
      clock_face_visible_(false) {}

void ScreenTimeoutController::register_events() {}

void ScreenTimeoutController::update() {
    if (!ui_manager_) {
        return;
    }

    auto* hardware = ui_manager_->hardware_manager;
    if (!hardware) {
        return;
    }

    auto* display = hardware->get_display();
    if (!display || !display->get_touch_driver()) {
        return;
    }

    // A grind is never idle: the weight is moving by definition and the progress
    // view has to stay up regardless of how long ago the screen was touched.
    if (ui_manager_->state_machine && ui_manager_->state_machine->is_state(UIState::GRINDING)) {
        wake();
        return;
    }

    const uint32_t now = millis();
    const uint32_t idle_ms = idle_duration_ms(now);
    const bool face_allowed = clock_face_allowed();

    set_clock_face_visible(face_allowed && idle_ms >= USER_SCREEN_AUTO_DIM_TIMEOUT_MS);
    if (clock_face_visible_) {
        ui_manager_->idle_screen.update(now);
    }

    // The face gets the first stage to itself; without it the screen dims at the
    // original mark instead.
    const uint32_t dim_after_ms = face_allowed
                                      ? USER_SCREEN_AUTO_DIM_TIMEOUT_MS + USER_IDLE_CLOCK_DIM_DELAY_MS
                                      : USER_SCREEN_AUTO_DIM_TIMEOUT_MS;
    set_dimmed(idle_ms >= dim_after_ms);
}

void ScreenTimeoutController::wake() {
    last_weight_activity_ms_ = millis();
    if (!ui_manager_) {
        return;
    }
    set_clock_face_visible(false);
    set_dimmed(false);
}

uint32_t ScreenTimeoutController::idle_duration_ms(uint32_t now_ms) {
    auto* hardware = ui_manager_->hardware_manager;
    auto* touch_driver = hardware->get_display()->get_touch_driver();

    // Measured over a short window on purpose: thermal drift cannot move the
    // reading half a gram in a second and a half, but a cup touching the scale
    // does it instantly - so "even the slightest load" wakes the grinder without
    // the face flickering back on by itself overnight.
    auto* sensor = hardware->get_weight_sensor();
    if (sensor && sensor->weight_range_exceeds(USER_IDLE_WAKE_WEIGHT_WINDOW_MS,
                                               USER_IDLE_WAKE_WEIGHT_THRESHOLD_G)) {
        last_weight_activity_ms_ = now_ms;
    }

    const uint32_t since_touch = touch_driver->get_ms_since_last_touch();
    const uint32_t since_weight = now_ms - last_weight_activity_ms_;
    return since_touch < since_weight ? since_touch : since_weight;
}

bool ScreenTimeoutController::clock_face_allowed() const {
    if (!ui_manager_ || !ui_manager_->state_machine) {
        return false;
    }

    if (!TimeSync::idle_clock_enabled()) {
        return false;
    }

    // An unsynced grinder has no honest time to show, so it keeps the original
    // dim-only behaviour until a BLE client or SNTP sets the clock.
    if (!TimeSync::is_synced()) {
        return false;
    }

    if (BlockingOperationOverlay::getInstance().is_operation_active()) {
        return false;
    }

    if (ui_manager_->grind_controller && ui_manager_->grind_controller->is_active()) {
        return false;
    }

    switch (ui_manager_->state_machine->get_current_state()) {
        case UIState::READY:
        case UIState::GRIND_COMPLETE:
        case UIState::GRIND_TIMEOUT:
        case UIState::MENU:
        case UIState::EDIT:
            return true;
        default:
            // Calibration, auto-tune, confirmations and the OTA/export progress views
            // are all mid-procedure - covering them would hide the very thing the user
            // walked away waiting on.
            return false;
    }
}

void ScreenTimeoutController::set_clock_face_visible(bool visible) {
    if (visible == clock_face_visible_) {
        return;
    }
    clock_face_visible_ = visible;

    if (visible) {
        ui_manager_->idle_screen.show();
        // Fill the labels in the same pass, so the face never renders a frame blank.
        ui_manager_->idle_screen.update(millis());
    } else {
        ui_manager_->idle_screen.hide();
    }
}

void ScreenTimeoutController::set_dimmed(bool dimmed) {
    if (dimmed == screen_dimmed_) {
        return;  // Also keeps wake() off the NVS brightness lookup on every state change
    }

    auto* display = ui_manager_->hardware_manager ? ui_manager_->hardware_manager->get_display() : nullptr;
    if (!display) {
        return;
    }

    float brightness = dimmed ? USER_SCREEN_BRIGHTNESS_DIMMED : USER_SCREEN_BRIGHTNESS_NORMAL;
    if (ui_manager_->menu_controller_) {
        brightness = dimmed ? ui_manager_->menu_controller_->get_screensaver_brightness()
                            : ui_manager_->menu_controller_->get_normal_brightness();
    }

    display->set_brightness(brightness);
    screen_dimmed_ = dimmed;
}
