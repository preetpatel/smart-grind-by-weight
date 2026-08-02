#include "brew_entry_controller.h"

#include <Arduino.h>
#include <cmath>

#include "../../config/constants.h"
#include "../../logging/grind_logging.h"
#include "../../system/bean_config.h"
#include "../../system/brew_log.h"
#include "../../system/wifi_service.h"
#include "../ui_manager.h"

namespace {
    float snap_to_tenth(float value) {
        return roundf(value * 10.0f) / 10.0f;
    }
}

BrewEntryController::BrewEntryController(UIManager* manager)
    : ui_manager_(manager) {}

void BrewEntryController::register_events() {
    if (!ui_manager_) return;
    BrewEntryScreen& screen = ui_manager_->brew_entry_screen;

    // Same interaction grammar as the target editor: a click steps one fine
    // increment, holding escalates through the jog stages.
    auto bind_jog = [this](lv_obj_t* button, int direction) {
        if (!button) return;
        struct Binding { BrewEntryController* controller; int direction; };
        auto* binding = new Binding{this, direction};
        lv_obj_add_event_cb(button, [](lv_event_t* e) {
            auto* bound = static_cast<Binding*>(lv_event_get_user_data(e));
            if (!bound || !bound->controller || !bound->controller->ui_manager_) return;
            UIManager* ui = bound->controller->ui_manager_;
            lv_event_code_t code = lv_event_get_code(e);
            if (code == LV_EVENT_CLICKED) {
                bound->controller->adjust_output(bound->direction * USER_FINE_WEIGHT_ADJUSTMENT_G);
            } else if (code == LV_EVENT_LONG_PRESSED) {
                if (ui->jog_adjust_controller_) ui->jog_adjust_controller_->start(bound->direction);
            } else if (code == LV_EVENT_RELEASED || code == LV_EVENT_PRESS_LOST) {
                if (ui->jog_adjust_controller_) ui->jog_adjust_controller_->stop();
            }
        }, LV_EVENT_ALL, binding);
    };
    bind_jog(screen.get_minus_button(), -1);
    bind_jog(screen.get_plus_button(), 1);

    if (lv_obj_t* done = screen.get_done_button()) {
        lv_obj_add_event_cb(done, [](lv_event_t* e) {
            if (lv_event_get_code(e) != LV_EVENT_CLICKED) return;
            if (auto* controller = static_cast<BrewEntryController*>(lv_event_get_user_data(e))) {
                controller->finish(true);
            }
        }, LV_EVENT_CLICKED, this);
    }
    if (lv_obj_t* skip = screen.get_skip_button()) {
        lv_obj_add_event_cb(skip, [](lv_event_t* e) {
            if (lv_event_get_code(e) != LV_EVENT_CLICKED) return;
            if (auto* controller = static_cast<BrewEntryController*>(lv_event_get_user_data(e))) {
                controller->finish(false);
            }
        }, LV_EVENT_CLICKED, this);
    }
}

void BrewEntryController::arm(float dose_g) {
    bean_config.reload_if_dirty();
    if (!bean_config.is_configured() || !(dose_g > 0.0f)) {
        pending_ = false;
        return;
    }
    uint32_t session_id = grind_logger.get_last_started_session_id();
    if (session_id == 0 || session_id == settled_session_id_) {
        // Logging was off for this grind (no session to attach a brew to),
        // or this grind's prompt is already answered.
        pending_ = false;
        return;
    }
    pending_ = true;
    session_id_ = session_id;
    session_timestamp_ = grind_logger.get_last_started_session_timestamp();
    // Dose after any top-up pulses - what actually goes in the portafilter,
    // not the frozen final_weight the session log keeps.
    expected_g_ = snap_to_tenth(dose_g * bean_config.get_ratio());
}

void BrewEntryController::discard_pending() {
    if (!pending_) return;
    settled_session_id_ = session_id_;
    pending_ = false;
}

bool BrewEntryController::begin_entry() {
    if (!ui_manager_ || !pending_) return false;
    pending_ = false;
    settled_session_id_ = session_id_;
    output_g_ = expected_g_;

    char name[USER_BEAN_NAME_MAX_LENGTH + 1];
    bean_config.get_name(name, sizeof(name));
    ui_manager_->brew_entry_screen.set_bean_name(name);
    refresh_screen();
    ui_manager_->switch_to_state(UIState::BREW_ENTRY);

    cancel_timeout();
    timeout_timer_ = lv_timer_create(timeout_cb, USER_BREW_ENTRY_TIMEOUT_MS, this);
    lv_timer_set_repeat_count(timeout_timer_, 1);
    return true;
}

void BrewEntryController::adjust_output(float delta_g) {
    output_g_ = snap_to_tenth(output_g_ + delta_g);
    if (output_g_ < 0.0f) output_g_ = 0.0f;
    if (output_g_ > USER_BREW_OUTPUT_MAX_G) output_g_ = USER_BREW_OUTPUT_MAX_G;
    refresh_screen();
}

void BrewEntryController::refresh_screen() {
    if (!ui_manager_) return;
    ui_manager_->brew_entry_screen.set_values(output_g_, expected_g_);
}

void BrewEntryController::finish(bool save) {
    if (!ui_manager_ || !ui_manager_->state_machine) return;
    if (!ui_manager_->state_machine->is_state(UIState::BREW_ENTRY)) return;
    cancel_timeout();

    if (save && output_g_ > 0.0f) {
        brew_log.queue_record(session_id_, session_timestamp_, output_g_,
                              bean_config.get_brew_time_s());
        // The record's upload response carries fresh advice, so ask for a
        // window now rather than waiting for the daily sweep.
        wifi_service.request_sync_now();
    } else {
        LOG_BLE("[BREW] Shot for session %lu skipped\n", (unsigned long)session_id_);
    }
    ui_manager_->switch_to_state(UIState::READY);
}

void BrewEntryController::on_state_changed(UIState new_state) {
    if (new_state != UIState::BREW_ENTRY) cancel_timeout();
}

void BrewEntryController::cancel_timeout() {
    if (timeout_timer_) {
        lv_timer_del(timeout_timer_);
        timeout_timer_ = nullptr;
    }
}

void BrewEntryController::timeout_cb(lv_timer_t* timer) {
    auto* controller = static_cast<BrewEntryController*>(lv_timer_get_user_data(timer));
    if (!controller || !controller->ui_manager_) return;
    controller->timeout_timer_ = nullptr;
    // Nobody came back - fall out to ready with nothing recorded.
    if (controller->ui_manager_->state_machine
        && controller->ui_manager_->state_machine->is_state(UIState::BREW_ENTRY)) {
        controller->ui_manager_->switch_to_state(UIState::READY);
    }
}
