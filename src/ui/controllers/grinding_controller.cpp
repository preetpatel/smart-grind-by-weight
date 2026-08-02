#include "grinding_controller.h"

#include <Arduino.h>
#include <Preferences.h>
#include <cmath>
#include <cstdio>
#include <cstring>

#include "../../config/constants.h"
#include "../../controllers/grind_events.h"
#include "../../controllers/grind_mode.h"
#include "../../logging/grind_logging.h"
#include "../../system/time_sync.h"
#include "../ui_helpers.h"
#include "../ui_manager.h"

GrindingUIController* GrindingUIController::instance_ = nullptr;

GrindingUIController::GrindingUIController(UIManager* manager)
    : ui_manager_(manager) {
    instance_ = this;
}

// The action bar. One full-bleed strip along the bottom of the panel rather than
// floating circles: at 7.2 mm tall and the full 21.8 mm across it is the easiest
// thing on the screen to hit with a wet thumb, and it means every screen has
// exactly one obvious action. States that offer two actions (complete, purge
// confirm) split the strip; the amber half is always the one that moves you
// forward.
static lv_obj_t* create_action_half(lv_obj_t** out_label) {
    lv_obj_t* button = lv_btn_create(lv_scr_act());
    lv_obj_set_size(button, HW_DISPLAY_WIDTH_PX, UI_ACTION_BAR_HEIGHT_PX);
    lv_obj_align(button, LV_ALIGN_BOTTOM_MID, 0, 0);
    lv_obj_set_style_radius(button, 0, 0);
    lv_obj_set_style_border_width(button, 0, 0);
    lv_obj_set_style_shadow_width(button, 0, 0);
    lv_obj_set_style_pad_all(button, 0, 0);
    lv_obj_set_style_bg_opa(button, LV_OPA_COVER, 0);
    lv_obj_set_style_bg_color(button, lv_color_hex(UI_COLOR_ACCENT), 0);

    *out_label = lv_label_create(button);
    lv_label_set_text(*out_label, "");
    lv_obj_center(*out_label);
    lv_obj_set_style_text_font(*out_label, UI_FONT_BODY, 0);
    lv_obj_set_style_text_letter_space(*out_label, 4, 0);
    lv_obj_set_style_text_color(*out_label, lv_color_hex(UI_COLOR_ACCENT_INK), 0);

    lv_obj_set_style_bg_opa(button, LV_OPA_80, LV_STATE_PRESSED);
    ui_add_press_feedback(button);

    return button;
}

void GrindingUIController::build_controls() {
    if (!ui_manager_) {
        return;
    }

    grind_button_ = create_action_half(&grind_icon_);
    pulse_button_ = create_action_half(&pulse_icon_);
    lv_obj_add_flag(pulse_button_, LV_OBJ_FLAG_HIDDEN);
}

// strong = the amber half: the action that moves you forward. Everything else is
// a hairline-topped ghost so that exactly one thing on screen is coloured.
void GrindingUIController::style_action(lv_obj_t* button, lv_obj_t* label, const char* text, bool strong) {
    if (!button || !label) {
        return;
    }

    set_label_text_if_changed(label, text);

    if (strong) {
        lv_obj_set_style_bg_opa(button, LV_OPA_COVER, 0);
        lv_obj_set_style_bg_color(button, lv_color_hex(UI_COLOR_ACCENT), 0);
        lv_obj_set_style_border_width(button, 0, 0);
        set_label_text_color_if_changed(label, lv_color_hex(UI_COLOR_ACCENT_INK));
    } else {
        lv_obj_set_style_bg_opa(button, LV_OPA_TRANSP, 0);
        lv_obj_set_style_border_color(button, lv_color_hex(UI_COLOR_LINE), 0);
        lv_obj_set_style_border_width(button, UI_HAIRLINE_PX, 0);
        lv_obj_set_style_border_side(button, LV_BORDER_SIDE_TOP, 0);
        set_label_text_color_if_changed(label, lv_color_hex(UI_COLOR_DIM));
    }
}

void GrindingUIController::place_action(lv_obj_t* button, bool full_width, bool align_right, int32_t width) {
    if (!button) {
        return;
    }
    lv_obj_set_size(button, full_width ? HW_DISPLAY_WIDTH_PX : width, UI_ACTION_BAR_HEIGHT_PX);
    lv_obj_align(button, full_width ? LV_ALIGN_BOTTOM_MID
                                    : (align_right ? LV_ALIGN_BOTTOM_RIGHT : LV_ALIGN_BOTTOM_LEFT),
                 0, 0);
}

void GrindingUIController::register_events() {
    if (!ui_manager_) {
        return;
    }

    if (grind_button_) {
        lv_obj_add_event_cb(grind_button_, [](lv_event_t* e) {
            if (lv_event_get_code(e) != LV_EVENT_CLICKED) {
                return;
            }
            auto* controller = static_cast<GrindingUIController*>(lv_event_get_user_data(e));
            if (controller) {
                controller->handle_grind_button();
            }
        }, LV_EVENT_CLICKED, this);
    }

    if (pulse_button_) {
        lv_obj_add_event_cb(pulse_button_, [](lv_event_t* e) {
            if (lv_event_get_code(e) != LV_EVENT_CLICKED) {
                return;
            }
            auto* controller = static_cast<GrindingUIController*>(lv_event_get_user_data(e));
            if (controller) {
                controller->handle_pulse_button();
            }
        }, LV_EVENT_CLICKED, this);
    }

    if (lv_obj_t* arc = ui_manager_->grinding_screen.get_arc_screen_obj()) {
        lv_obj_add_event_cb(arc, [](lv_event_t* e) {
            if (lv_event_get_code(e) == LV_EVENT_CLICKED) {
                if (auto* controller = static_cast<GrindingUIController*>(lv_event_get_user_data(e))) {
                    controller->handle_layout_toggle();
                }
            }
        }, LV_EVENT_CLICKED, this);
    }

    if (lv_obj_t* chart = ui_manager_->grinding_screen.get_chart_screen_obj()) {
        lv_obj_add_event_cb(chart, [](lv_event_t* e) {
            if (lv_event_get_code(e) == LV_EVENT_CLICKED) {
                if (auto* controller = static_cast<GrindingUIController*>(lv_event_get_user_data(e))) {
                    controller->handle_layout_toggle();
                }
            }
        }, LV_EVENT_CLICKED, this);
    }

    // NOTE: Purge confirm reuses existing grind_button_ (CANCEL) and pulse_button_ (CONTINUE)
    // No additional event registration needed - handle_pulse_button() checks for PURGE_CONFIRM phase
}

void GrindingUIController::on_state_changed(UIState new_state) {
    if (!ui_manager_) {
        return;
    }

    if (new_state != UIState::GRIND_COMPLETE && grind_complete_timer_) {
        lv_timer_del(grind_complete_timer_);
        grind_complete_timer_ = nullptr;
    }
    if (new_state != UIState::GRIND_TIMEOUT && grind_timeout_timer_) {
        lv_timer_del(grind_timeout_timer_);
        grind_timeout_timer_ = nullptr;
    }

    switch (new_state) {
        case UIState::READY:
            enter_ready_state();
            break;
        case UIState::EDIT:
            enter_edit_state();
            break;
        case UIState::GRINDING:
            enter_grinding_state();
            break;
        case UIState::GRIND_COMPLETE:
            enter_grind_complete_state();
            break;
        case UIState::GRIND_TIMEOUT:
            enter_grind_timeout_state();
            break;
        case UIState::MENU:
        case UIState::CALIBRATION:
        case UIState::CONFIRM:
        case UIState::OTA_UPDATE:
        case UIState::OTA_UPDATE_FAILED:
            enter_menu_state();
            break;
        default:
            break;
    }

    update_grind_button_icon();
}

void GrindingUIController::update(UIState current_state) {
    if (!ui_manager_) {
        return;
    }

    switch (current_state) {
        case UIState::GRIND_COMPLETE: {
            // While a top-up pulse is landing the control loop streams live weight and progress
            // at 20ms - don't fight it here with the frozen post-grind progress value.
            if (ui_manager_->grind_controller && ui_manager_->grind_controller->is_additional_pulse_active()) {
                break;
            }
            WeightSensor* weight_sensor = ui_manager_->hardware_manager->get_weight_sensor();
            if (weight_sensor) {
                float current_weight = weight_sensor->get_display_weight();
                ui_manager_->grinding_screen.update_current_weight(current_weight);
            }
            ui_manager_->grinding_screen.update_progress(final_grind_progress_);
            break;
        }
        case UIState::GRIND_TIMEOUT: {
            ui_manager_->grinding_screen.update_current_weight(error_grind_weight_);
            ui_manager_->grinding_screen.update_progress(error_grind_progress_);
            char error_display[64];
            const char* message = error_message_[0] ? error_message_ : "Error";
            std::snprintf(error_display, sizeof(error_display), "%s", message);
            ui_manager_->grinding_screen.update_target_weight_text(error_display);
            break;
        }
        default:
            break;
    }
}

void GrindingUIController::handle_grind_button() {
    if (!ui_manager_ || !ui_manager_->state_machine) {
        return;
    }

    LOG_BLE("[%lums BUTTON_PRESS] Grind button pressed in state: %s\n",
            millis(), ui_manager_->state_machine->is_state(UIState::READY) ? "READY" :
                       ui_manager_->state_machine->is_state(UIState::GRINDING) ? "GRINDING" :
                       ui_manager_->state_machine->is_state(UIState::GRIND_COMPLETE) ? "GRIND_COMPLETE" :
                       ui_manager_->state_machine->is_state(UIState::GRIND_TIMEOUT) ? "GRIND_TIMEOUT" :
                       ui_manager_->state_machine->is_state(UIState::PURGE_CONFIRM) ? "PURGE_CONFIRM" : "OTHER");

    if (ui_manager_->state_machine->is_state(UIState::PURGE_CONFIRM)) {
        // Cancel grind during purge confirmation
        if (ui_manager_->grind_controller) {
            ui_manager_->grind_controller->stop_grind();
        }
    } else if (ui_manager_->state_machine->is_state(UIState::READY)) {
        // A blocked ready screen sends you where the block can be cleared rather
        // than starting a grind the controller would refuse.
        if (ui_manager_->ready_block == UIManager::ReadyBlock::CALIBRATE) {
            ui_manager_->switch_to_state(UIState::CALIBRATION);
            return;
        }
        if (ui_manager_->ready_block == UIManager::ReadyBlock::DIAGNOSE) {
            ui_manager_->switch_to_state(UIState::MENU);
            return;
        }

        if (ui_manager_->grind_controller && ui_manager_->profile_controller) {
            ui_manager_->grind_controller->set_grind_profile_id(ui_manager_->profile_controller->get_current_profile());
        }

        LOG_BLE("[%lums GRIND_START] About to call start_grind()\n", millis());
        error_message_[0] = '\0';
        error_grind_weight_ = 0.0f;
        error_grind_progress_ = 0;

        if (ui_manager_->profile_controller && ui_manager_->grind_controller) {
            float target_weight = ui_manager_->profile_controller->get_current_weight();
            float target_time_seconds = ui_manager_->profile_controller->get_current_time();
            uint32_t target_time_ms = static_cast<uint32_t>((target_time_seconds * 1000.0f) + 0.5f);
            ui_manager_->grind_controller->start_grind(target_weight, target_time_ms, ui_manager_->current_mode);
        }
        LOG_BLE("[%lums GRIND_START] start_grind() returned\n", millis());
    } else if (ui_manager_->state_machine->is_state(UIState::GRINDING)) {
        if (ui_manager_->grind_controller) {
            ui_manager_->grind_controller->stop_grind();
        }
    } else if (ui_manager_->state_machine->is_state(UIState::GRIND_COMPLETE) ||
               ui_manager_->state_machine->is_state(UIState::GRIND_TIMEOUT)) {
        if (ui_manager_->grind_controller) {
            ui_manager_->grind_controller->return_to_idle();
        }
    }
}

void GrindingUIController::handle_pulse_button() {
    if (!ui_manager_ || !ui_manager_->grind_controller) {
        return;
    }

    // Check if we're in PURGE_CONFIRM phase - pulse button acts as CONTINUE
    if (ui_manager_->purge_confirm_screen.is_visible()) {
        handle_purge_confirm_continue();
        return;
    }

    // Normal top-up pulse behavior (weight and time mode)
    if (ui_manager_->grind_controller->can_pulse()) {
        LOG_BLE("[UIManager] Pulse button clicked - requesting additional pulse\n");
        ui_manager_->grind_controller->start_additional_pulse();
        reset_grind_complete_timer();
    } else {
        LOG_BLE("[UIManager] Pulse button clicked but pulsing not allowed\n");
    }
}

void GrindingUIController::handle_layout_toggle() {
    if (!ui_manager_ || !ui_manager_->state_machine) {
        return;
    }

    if (ui_manager_->state_machine->is_state(UIState::GRINDING) ||
        ui_manager_->state_machine->is_state(UIState::GRIND_COMPLETE) ||
        ui_manager_->state_machine->is_state(UIState::GRIND_TIMEOUT)) {
        GrindScreenLayout current_layout = ui_manager_->grinding_screen.get_layout();
        if (current_layout == GrindScreenLayout::MINIMAL_ARC) {
            ui_manager_->grinding_screen.set_layout(GrindScreenLayout::NERDY_CHART);
        } else {
            ui_manager_->grinding_screen.set_layout(GrindScreenLayout::MINIMAL_ARC);
        }
    }
}

void GrindingUIController::handle_purge_confirm_continue() {
    if (!ui_manager_ || !ui_manager_->grind_controller) {
        return;
    }

    // Check if "Keep purge grinds from now on" checkbox is checked
    if (ui_manager_->purge_confirm_screen.is_checkbox_checked()) {
        LOG_BLE("[%lums PURGE] User chose to keep grinds - switching to Prime mode\n", millis());

        // Switch grinder purge mode from Purge to Prime in preferences
        auto* hardware = ui_manager_->get_hardware_manager();
        Preferences* prefs = hardware ? hardware->get_preferences() : nullptr;
        if (prefs) {
            prefs->putInt(GrindController::PREF_KEY_GRINDER_MODE, static_cast<int>(PrimeDoseMode::KEEP));
        }
    }

    // Hide the purge confirmation screen and continue grinding
    ui_manager_->purge_confirm_screen.hide();
    ui_manager_->switch_to_state(UIState::GRINDING);

    // Tell the grind controller to continue from PURGE_CONFIRM to PREDICTIVE
    ui_manager_->grind_controller->continue_from_purge();
}

void GrindingUIController::update_grind_button_icon() {
    if (!ui_manager_ || !grind_button_ || !grind_icon_) {
        return;
    }

    if (ui_manager_->state_machine->is_state(UIState::PURGE_CONFIRM)) {
        // Stopping is the quiet half here; continuing is what you came to do.
        style_action(grind_button_, grind_icon_, "STOP", false);
    } else if (ui_manager_->state_machine->is_state(UIState::GRINDING)) {
        // Nothing is amber while it runs - the grind itself is the event.
        style_action(grind_button_, grind_icon_, "STOP", false);
    } else if (ui_manager_->state_machine->is_state(UIState::GRIND_COMPLETE)) {
        style_action(grind_button_, grind_icon_, "DONE", true);
    } else if (ui_manager_->state_machine->is_state(UIState::GRIND_TIMEOUT)) {
        style_action(grind_button_, grind_icon_, "DONE", false);
    } else if (ui_manager_->ready_block == UIManager::ReadyBlock::CALIBRATE) {
        style_action(grind_button_, grind_icon_, "CALIBRATE", true);
    } else if (ui_manager_->ready_block == UIManager::ReadyBlock::DIAGNOSE) {
        style_action(grind_button_, grind_icon_, "DIAGNOSE", true);
    } else {
        style_action(grind_button_, grind_icon_, "GRIND", true);
    }

    update_button_layout();
}

void GrindingUIController::update_button_layout() {
    if (!ui_manager_ || !grind_button_) {
        return;
    }

    // Two states offer a second action, and in both the split is the same shape:
    // the quiet half on the left, the amber half taking the wider right side.
    constexpr int32_t kQuietWidth = 112;   // 40% of the panel
    constexpr int32_t kStrongWidth = HW_DISPLAY_WIDTH_PX - kQuietWidth;

    bool in_purge_confirm = ui_manager_->purge_confirm_screen.is_visible();

    // Top-up pulses are offered after every completed grind, in both weight and time mode
    bool should_show_pulse = ui_manager_->state_machine->is_state(UIState::GRIND_COMPLETE);

    if (in_purge_confirm) {
        // STOP is the grind button (left, quiet); CONTINUE is the pulse button.
        place_action(grind_button_, false, false, kQuietWidth);
        place_action(pulse_button_, false, true, kStrongWidth);
        lv_obj_clear_flag(pulse_button_, LV_OBJ_FLAG_HIDDEN);
        style_action(pulse_button_, pulse_icon_, "CONTINUE", true);
        lv_obj_clear_state(pulse_button_, LV_STATE_DISABLED);
    } else if (should_show_pulse) {
        // DONE is the grind button and takes the amber right; the top-up pulse
        // is the quiet half, because most grinds do not need one.
        place_action(pulse_button_, false, false, kQuietWidth);
        place_action(grind_button_, false, true, kStrongWidth);
        lv_obj_clear_flag(pulse_button_, LV_OBJ_FLAG_HIDDEN);
        style_action(pulse_button_, pulse_icon_, "+ PULSE", false);

        const bool can_pulse = ui_manager_->grind_controller && ui_manager_->grind_controller->can_pulse();
        if (can_pulse) {
            lv_obj_clear_state(pulse_button_, LV_STATE_DISABLED);
            set_label_text_color_if_changed(pulse_icon_, lv_color_hex(UI_COLOR_DIM));
        } else {
            // A pulse is still landing: the half stays in place but stops
            // inviting a press rather than disappearing under the thumb.
            lv_obj_add_state(pulse_button_, LV_STATE_DISABLED);
            set_label_text_color_if_changed(pulse_icon_, lv_color_hex(UI_COLOR_LINE));
        }
    } else {
        place_action(grind_button_, true, false, HW_DISPLAY_WIDTH_PX);
        if (pulse_button_) {
            lv_obj_add_flag(pulse_button_, LV_OBJ_FLAG_HIDDEN);
        }
    }
}

void GrindingUIController::update_grinding_targets() {
    if (!ui_manager_ || !ui_manager_->grind_controller || !ui_manager_->profile_controller) {
        return;
    }

    const auto& session = ui_manager_->grind_controller->get_session_descriptor();
    ui_manager_->grinding_screen.set_chart_time_prediction(session.target_time_ms);
    ui_manager_->grinding_screen.update_target_weight(session.target_weight);
    if (session.mode == GrindMode::TIME && session.target_time_ms > 0) {
        float target_time_seconds = static_cast<float>(session.target_time_ms) / 1000.0f;
        ui_manager_->grinding_screen.update_target_time(target_time_seconds);
    }
}

void GrindingUIController::reset_grind_complete_timer() {
    if (!ui_manager_ || !ui_manager_->state_machine) {
        return;
    }

    if (ui_manager_->state_machine->is_state(UIState::GRIND_COMPLETE) && grind_complete_timer_) {
        lv_timer_del(grind_complete_timer_);
        grind_complete_timer_ = nullptr;
        start_grind_complete_timer();
    }
}

void GrindingUIController::handle_grind_event(const GrindEventData& event_data) {
    if (!ui_manager_ || !ui_manager_->state_machine) {
        return;
    }

    switch (event_data.event) {
        case UIGrindEvent::PHASE_CHANGED: {
            ui_manager_->current_mode = event_data.mode;

            // Handle PURGE_CONFIRM phase specially - show purge confirmation popup
            if (event_data.phase == GrindPhase::PURGE_CONFIRM) {
                LOG_UI_DEBUG("[%lums UI_TRANSITION] Switching to PURGE_CONFIRM state\n", millis());
                ui_manager_->switch_to_state(UIState::PURGE_CONFIRM);
                update_grind_button_icon();  // Update button icon to STOP and reposition for dual-button layout
            } else if (event_data.phase != GrindPhase::IDLE &&
                       event_data.phase != GrindPhase::TIME_ADDITIONAL_PULSE &&
                       !ui_manager_->state_machine->is_state(UIState::GRINDING)) {
                LOG_UI_DEBUG("[%lums UI_TRANSITION] Switching to GRINDING state due to phase: %s\n",
                             millis(), event_data.phase_display_text);
                WeightSensor* weight_sensor = ui_manager_->hardware_manager->get_weight_sensor();
                ui_manager_->grinding_screen.update_profile_name(ui_manager_->profile_controller->get_current_name());
                ui_manager_->grinding_screen.set_mode(ui_manager_->current_mode);
                chart_updates_enabled_ = true;
                update_grinding_targets();
                if (weight_sensor) {
                    ui_manager_->grinding_screen.update_current_weight(weight_sensor->get_display_weight());
                }
                ui_manager_->grinding_screen.update_progress(0);
                ui_manager_->switch_to_state(UIState::GRINDING);

                if (event_data.phase == GrindPhase::INITIALIZING) {
                    ui_manager_->grind_controller->ui_acknowledge_phase_transition();
                    LOG_UI_DEBUG("[%lums UI_ACKNOWLEDGMENT] INITIALIZING phase confirmed, ready for SETUP\n", millis());
                }
            }

            if (ui_manager_->state_machine->is_state(UIState::GRIND_COMPLETE)) {
                update_button_layout();
            }

            if (event_data.show_taring_text) {
                ui_manager_->grinding_screen.update_tare_display();
            } else {
                ui_manager_->grinding_screen.update_current_weight(event_data.current_weight);
                ui_manager_->grinding_screen.update_progress(event_data.progress_percent);

                if (chart_updates_enabled_ &&
                    event_data.phase != GrindPhase::IDLE && event_data.phase != GrindPhase::TARING &&
                    event_data.phase != GrindPhase::TARE_CONFIRM && event_data.phase != GrindPhase::INITIALIZING &&
                    event_data.phase != GrindPhase::SETUP && event_data.phase != GrindPhase::COMPLETED &&
                    event_data.phase != GrindPhase::TIMEOUT && event_data.phase != GrindPhase::TIME_ADDITIONAL_PULSE &&
                    event_data.phase != GrindPhase::PURGE_CONFIRM) {
                    ui_manager_->grinding_screen.add_chart_data_point(event_data.current_weight, event_data.flow_rate, millis());
                }
            }
            break;
        }
        case UIGrindEvent::PROGRESS_UPDATED: {
            if (event_data.show_taring_text) {
                ui_manager_->grinding_screen.update_tare_display();
            } else {
                ui_manager_->current_mode = event_data.mode;
                ui_manager_->grinding_screen.set_mode(ui_manager_->current_mode);
                ui_manager_->grinding_screen.update_current_weight(event_data.current_weight);
                ui_manager_->grinding_screen.update_progress(event_data.progress_percent);

                if (chart_updates_enabled_ &&
                    event_data.phase != GrindPhase::IDLE && event_data.phase != GrindPhase::TARING &&
                    event_data.phase != GrindPhase::TARE_CONFIRM && event_data.phase != GrindPhase::INITIALIZING &&
                    event_data.phase != GrindPhase::SETUP && event_data.phase != GrindPhase::COMPLETED &&
                    event_data.phase != GrindPhase::TIMEOUT && event_data.phase != GrindPhase::TIME_ADDITIONAL_PULSE &&
                    event_data.phase != GrindPhase::PURGE_CONFIRM) {
                    ui_manager_->grinding_screen.add_chart_data_point(event_data.current_weight, event_data.flow_rate, millis());
                }
            }
            break;
        }
        case UIGrindEvent::COMPLETED: {
            ui_manager_->current_mode = event_data.mode;
            ui_manager_->grinding_screen.set_mode(ui_manager_->current_mode);
            final_grind_weight_ = event_data.final_weight;
            final_grind_progress_ = event_data.progress_percent;
            store_last_grind(event_data.final_weight);  // Feeds the ready screen's context
            LOG_BLE("GRIND COMPLETE - Final settled weight captured: %.2fg (Progress: %d%%)\n",
                    final_grind_weight_, final_grind_progress_);
            chart_updates_enabled_ = false;
            ui_manager_->switch_to_state(UIState::GRIND_COMPLETE);
            start_grind_complete_timer();
            break;
        }
        case UIGrindEvent::TIMEOUT: {
            ui_manager_->current_mode = event_data.mode;
            ui_manager_->grinding_screen.set_mode(ui_manager_->current_mode);
            error_grind_weight_ = event_data.error_weight;
            error_grind_progress_ = event_data.error_progress;
            const char* message = event_data.error_message ? event_data.error_message : "Error";
            std::strncpy(error_message_, message, sizeof(error_message_) - 1);
            error_message_[sizeof(error_message_) - 1] = '\0';
            LOG_BLE("GRIND ERROR - %s, Weight: %.2fg (Progress: %d%%)\n",
                    error_message_, error_grind_weight_, error_grind_progress_);
            chart_updates_enabled_ = false;
            ui_manager_->switch_to_state(UIState::GRIND_TIMEOUT);
            start_grind_timeout_timer();
            break;
        }
        case UIGrindEvent::STOPPED: {
            cancel_timers();
            chart_updates_enabled_ = false;
            ui_manager_->switch_to_state(UIState::READY);
            break;
        }
        case UIGrindEvent::BACKGROUND_CHANGE:
#if DEBUG_ENABLE_GRINDER_BACKGROUND_INDICATOR
        {
            static lv_style_t style_bg;
            static bool style_initialized = false;

            if (!style_initialized) {
                lv_style_init(&style_bg);
                style_initialized = true;
            }

#if defined(DEBUG_ENABLE_LOADCELL_MOCK) && (DEBUG_ENABLE_LOADCELL_MOCK != 0)
            lv_color_t inactive_color = lv_color_hex(THEME_COLOR_BACKGROUND_MOCK);
#else
            lv_color_t inactive_color = lv_color_hex(UI_COLOR_BG);
#endif
            lv_color_t bg_color = event_data.background_active ?
                lv_color_hex(THEME_COLOR_GRINDER_ACTIVE) :
                inactive_color;

            lv_style_set_bg_color(&style_bg, bg_color);
            lv_obj_add_style(lv_scr_act(), &style_bg, 0);

            LOG_UI_DEBUG("[UIManager] Background: %s\n", event_data.background_active ? "ACTIVE" : "INACTIVE");
        }
#endif
            break;
        case UIGrindEvent::PULSE_AVAILABLE:
            LOG_BLE("[UIManager] Pulse available - updating button layout\n");
            update_button_layout();
            break;
        case UIGrindEvent::PULSE_STARTED:
            LOG_BLE("[UIManager] Pulse #%d started (%.1fms)\n",
                    event_data.pulse_count, (float)event_data.pulse_duration_ms);
#if DEBUG_ENABLE_GRINDER_BACKGROUND_INDICATOR
        {
            // lv_style_init() memzeroes the style, orphaning the heap block allocated by a
            // previous lv_style_set_*(). Initialize once, then only update the value.
            static lv_style_t style_bg;
            static bool style_initialized = false;

            if (!style_initialized) {
                lv_style_init(&style_bg);
                style_initialized = true;
            }

            lv_style_set_bg_color(&style_bg, lv_color_hex(THEME_COLOR_GRINDER_ACTIVE));
            lv_obj_add_style(lv_scr_act(), &style_bg, 0);
        }
#endif
            break;
        case UIGrindEvent::PULSE_COMPLETED:
            LOG_BLE("[UIManager] Pulse #%d completed - weight: %.2fg\n",
                    event_data.pulse_count, event_data.current_weight);
            ui_manager_->grinding_screen.update_current_weight(event_data.current_weight);
            update_button_layout();
            break;
        default:
            break;
    }
}

void GrindingUIController::dispatch_event(const GrindEventData& event_data) {
    if (instance_) {
        instance_->handle_grind_event(event_data);
    }
}

// Kept in its own NVS namespace so a factory reset of the grind settings does
// not have to know about it, and so the write is a single 8-byte pair.
namespace {
constexpr const char* kLastGrindNamespace = "lastgrind";
constexpr const char* kLastGrindWeightKey = "weight";
constexpr const char* kLastGrindEpochKey = "epoch";
}  // namespace

void GrindingUIController::store_last_grind(float weight) {
    last_grind_weight_ = weight;
    last_grind_epoch_ = TimeSync::is_synced() ? TimeSync::now_epoch() : 0;

    Preferences prefs;
    if (prefs.begin(kLastGrindNamespace, false)) {
        prefs.putFloat(kLastGrindWeightKey, last_grind_weight_);
        prefs.putUInt(kLastGrindEpochKey, last_grind_epoch_);
        prefs.end();
    }
}

void GrindingUIController::load_last_grind() {
    Preferences prefs;
    if (prefs.begin(kLastGrindNamespace, true)) {
        last_grind_weight_ = prefs.getFloat(kLastGrindWeightKey, 0.0f);
        last_grind_epoch_ = prefs.getUInt(kLastGrindEpochKey, 0);
        prefs.end();
    }
}

void GrindingUIController::enter_ready_state() {
    if (!grind_button_) {
        return;
    }

    lv_obj_clear_flag(grind_button_, LV_OBJ_FLAG_HIDDEN);
    if (pulse_button_) {
        lv_obj_add_flag(pulse_button_, LV_OBJ_FLAG_HIDDEN);
    }
    ui_manager_->grinding_screen.set_mode(ui_manager_->current_mode);
}

void GrindingUIController::enter_edit_state() {
    if (grind_button_) {
        lv_obj_add_flag(grind_button_, LV_OBJ_FLAG_HIDDEN);
    }
    if (pulse_button_) {
        lv_obj_add_flag(pulse_button_, LV_OBJ_FLAG_HIDDEN);
    }
}

void GrindingUIController::enter_grinding_state() {
    WeightSensor* weight_sensor = ui_manager_->hardware_manager->get_weight_sensor();
    // Clear any verdict colour left over from the previous grind.
    ui_manager_->grinding_screen.set_result_tone(IGrindingScreen::ResultTone::RUNNING);
    ui_manager_->grinding_screen.reset_chart_data();
    ui_manager_->grinding_screen.update_profile_name(ui_manager_->profile_controller->get_current_name());
    ui_manager_->grinding_screen.set_mode(ui_manager_->current_mode);
    chart_updates_enabled_ = true;
    update_grinding_targets();
    if (weight_sensor) {
        ui_manager_->grinding_screen.update_current_weight(weight_sensor->get_display_weight());
    }
    ui_manager_->grinding_screen.update_progress(0);
    if (grind_button_) {
        lv_obj_clear_flag(grind_button_, LV_OBJ_FLAG_HIDDEN);
    }
}

void GrindingUIController::enter_grind_complete_state() {
    if (grind_button_) {
        lv_obj_clear_flag(grind_button_, LV_OBJ_FLAG_HIDDEN);
    }
    ui_manager_->grinding_screen.update_profile_name(ui_manager_->profile_controller->get_current_name());
    ui_manager_->grinding_screen.set_mode(ui_manager_->current_mode);
    ui_manager_->grinding_screen.update_current_weight(final_grind_weight_);
    ui_manager_->grinding_screen.update_progress(final_grind_progress_);

    // The verdict, not two numbers to subtract in your head. Weight mode only -
    // in time mode there is no target weight to have missed.
    if (ui_manager_->current_mode == GrindMode::WEIGHT && ui_manager_->grind_controller) {
        const float target = ui_manager_->grind_controller->get_session_descriptor().target_weight;
        const float error = final_grind_weight_ - target;
        char verdict[48];
        if (fabsf(error) < 0.05f) {
            snprintf(verdict, sizeof(verdict), "on target, %.1f g", static_cast<double>(target));
        } else {
            snprintf(verdict, sizeof(verdict), "%.1f g %s %.1f", static_cast<double>(fabsf(error)),
                     error > 0.0f ? "over" : "under", static_cast<double>(target));
        }
        ui_manager_->grinding_screen.update_target_weight_text(verdict);
    }
    ui_manager_->grinding_screen.set_result_tone(IGrindingScreen::ResultTone::GOOD);
}

void GrindingUIController::enter_grind_timeout_state() {
    if (grind_button_) {
        lv_obj_clear_flag(grind_button_, LV_OBJ_FLAG_HIDDEN);
    }
    ui_manager_->grinding_screen.set_mode(ui_manager_->current_mode);
    ui_manager_->grinding_screen.set_result_tone(IGrindingScreen::ResultTone::BAD);
    ui_manager_->grinding_screen.update_profile_name("TIMED OUT");
    char error_display[64];
    const char* message = error_message_[0] ? error_message_ : "Error";
    std::snprintf(error_display, sizeof(error_display), "%s", message);
    ui_manager_->grinding_screen.update_target_weight_text(error_display);
    ui_manager_->grinding_screen.update_current_weight(error_grind_weight_);
    ui_manager_->grinding_screen.update_progress(error_grind_progress_);
}

void GrindingUIController::enter_menu_state() {
    if (grind_button_) {
        lv_obj_add_flag(grind_button_, LV_OBJ_FLAG_HIDDEN);
    }
    if (pulse_button_) {
        lv_obj_add_flag(pulse_button_, LV_OBJ_FLAG_HIDDEN);
    }
}

void GrindingUIController::start_grind_complete_timer() {
    if (grind_complete_timer_) {
        lv_timer_del(grind_complete_timer_);
    }
    grind_complete_timer_ = lv_timer_create(grind_complete_timer_cb, 60000, this);
    lv_timer_set_repeat_count(grind_complete_timer_, 1);
}

void GrindingUIController::start_grind_timeout_timer() {
    if (grind_timeout_timer_) {
        lv_timer_del(grind_timeout_timer_);
    }
    grind_timeout_timer_ = lv_timer_create(grind_timeout_timer_cb, 60000, this);
    lv_timer_set_repeat_count(grind_timeout_timer_, 1);
}

void GrindingUIController::cancel_timers() {
    if (grind_complete_timer_) {
        lv_timer_del(grind_complete_timer_);
        grind_complete_timer_ = nullptr;
    }
    if (grind_timeout_timer_) {
        lv_timer_del(grind_timeout_timer_);
        grind_timeout_timer_ = nullptr;
    }
}

void GrindingUIController::grind_complete_timer_cb(lv_timer_t* timer) {
    auto* controller = static_cast<GrindingUIController*>(lv_timer_get_user_data(timer));
    if (!controller || !controller->ui_manager_ || !controller->ui_manager_->grind_controller) {
        return;
    }

    controller->ui_manager_->grind_controller->return_to_idle();
    controller->grind_complete_timer_ = nullptr;
}

void GrindingUIController::grind_timeout_timer_cb(lv_timer_t* timer) {
    auto* controller = static_cast<GrindingUIController*>(lv_timer_get_user_data(timer));
    if (!controller || !controller->ui_manager_ || !controller->ui_manager_->grind_controller) {
        return;
    }

    controller->ui_manager_->grind_controller->return_to_idle();
    controller->grind_timeout_timer_ = nullptr;
}
