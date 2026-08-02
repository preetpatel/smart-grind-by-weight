#include "ready_controller.h"

#include <Preferences.h>
#include <lvgl.h>
#include "../../config/constants.h"
#include "../../controllers/grind_mode_traits.h"
#include "../../system/time_sync.h"
#include "../event_bridge_lvgl.h"
#include "../ui_manager.h"

ReadyUIController::ReadyUIController(UIManager* manager)
    : ui_manager_(manager) {}

namespace {

// "4 min ago", "2 h ago" - never a bare timestamp, because the clock may never
// have been set and the question is always "how long ago", not "at what time".
void format_elapsed(char* out, size_t out_len, uint32_t elapsed_ms) {
    const uint32_t minutes = elapsed_ms / 60000UL;
    if (minutes < 1) {
        snprintf(out, out_len, "just now");
    } else if (minutes < 60) {
        snprintf(out, out_len, "%lu min ago", static_cast<unsigned long>(minutes));
    } else {
        const uint32_t hours = minutes / 60;
        snprintf(out, out_len, "%lu h ago", static_cast<unsigned long>(hours));
    }
}

// The bullet is one of the few non-ASCII glyphs the built-in Montserrat faces
// carry (0x2022), so it is the only separator available above plain punctuation.
constexpr const char* kBullet = " \xE2\x80\xA2 ";

}  // namespace

void ReadyUIController::update() {
    update_context();
}

void ReadyUIController::update_context() {
    if (!ui_manager_) {
        return;
    }

    if (update_warning()) {
        return;  // The takeover owns the screen; context would be noise under it
    }

    char last_line[40] = {0};
    char grounds_line[40] = {0};

    // Line one: how the last grind landed, from NVS so it survives a power cut.
    // Without a synced clock the weight is still true but "2 h ago" would not
    // be, so the age is simply left off rather than invented.
    auto* grinding = ui_manager_->grinding_controller_.get();
    if (grinding && grinding->has_last_grind()) {
        const double weight = static_cast<double>(grinding->last_grind_weight());
        if (grinding->last_grind_age_known() && TimeSync::is_synced()) {
            const uint32_t now = TimeSync::now_epoch();
            const uint32_t then = grinding->last_grind_epoch();
            char ago[20];
            format_elapsed(ago, sizeof(ago), (now > then) ? (now - then) * 1000UL : 0);
            snprintf(last_line, sizeof(last_line), "%.1f g%s%s", weight, kBullet, ago);
        } else {
            snprintf(last_line, sizeof(last_line), "Last grind %.1f g", weight);
        }
    }

    // Line two: whether the grounds in the chute are still fresh. The grinder
    // already makes this call before every grind; this just says so before you
    // press rather than after.
    GrindController* grind = ui_manager_->grind_controller;
    Preferences* prefs = ui_manager_->hardware_manager ? ui_manager_->hardware_manager->get_preferences()
                                                       : nullptr;
    if (grind) {
        const float freshness_hours =
            prefs ? prefs->getFloat(GrindController::PREF_KEY_GRIND_FRESHNESS_HOURS,
                                    GRIND_FRESHNESS_DEFAULT_HOURS)
                  : GRIND_FRESHNESS_DEFAULT_HOURS;
        const uint64_t threshold_ms = static_cast<uint64_t>(freshness_hours * 3600000.0f);

        if (!grind->get_grinder_purged_since_boot()) {
            snprintf(grounds_line, sizeof(grounds_line), "Grounds stale, primes first");
        } else {
            const uint64_t now_ms = esp_timer_get_time() / 1000ULL;
            const uint64_t elapsed_ms = now_ms - grind->get_last_purge_runtime_ms();
            if (elapsed_ms >= threshold_ms) {
                snprintf(grounds_line, sizeof(grounds_line), "Grounds stale, primes first");
            } else {
                const uint64_t left_ms = threshold_ms - elapsed_ms;
                const uint32_t left_min = static_cast<uint32_t>(left_ms / 60000ULL);
                if (left_min >= 60) {
                    snprintf(grounds_line, sizeof(grounds_line), "Fresh for %lu h",
                             static_cast<unsigned long>(left_min / 60));
                } else {
                    snprintf(grounds_line, sizeof(grounds_line), "Fresh for %lu min",
                             static_cast<unsigned long>(left_min));
                }
            }
        }
    }

    ui_manager_->ready_screen.set_context(last_line, grounds_line);
}

// Returns true when the screen has been taken over. Only the conditions that
// actually stop a grind get the takeover: noise and mechanical instability are
// advisory and stay in the corner icon where they have always been.
bool ReadyUIController::update_warning() {
    auto* diagnostics = ui_manager_->diagnostics_controller_.get();
    if (!diagnostics) {
        return false;
    }

    const DiagnosticCode code = diagnostics->get_highest_priority_warning();
    const bool weight_mode = (ui_manager_->current_mode == GrindMode::WEIGHT);

    const char* title = nullptr;
    const char* phrase = nullptr;
    UIManager::ReadyBlock block = UIManager::ReadyBlock::NONE;

    switch (code) {
        case DiagnosticCode::HX711_NOT_CONNECTED:
            title = "Scale not detected";
            phrase = "Check the load cell wiring";
            block = UIManager::ReadyBlock::DIAGNOSE;
            break;
        case DiagnosticCode::HX711_SAMPLE_RATE_INVALID:
            title = "Scale wired for 80 SPS";
            phrase = "Move the rate jumper to 10 SPS";
            block = UIManager::ReadyBlock::DIAGNOSE;
            break;
        case DiagnosticCode::LOAD_CELL_SATURATED:
            // start_grind() refuses weight mode outright in this state.
            if (!weight_mode) break;
            title = "Load cell signal pegged";
            phrase = "Check the A+/A- wiring. Time mode still works.";
            block = UIManager::ReadyBlock::DIAGNOSE;
            break;
        case DiagnosticCode::LOAD_CELL_NOT_CALIBRATED:
            if (!weight_mode) break;
            title = "Scale not calibrated";
            phrase = "Every weight is a guess until it is. Time mode still works.";
            block = UIManager::ReadyBlock::CALIBRATE;
            break;
        default:
            break;
    }

    ui_manager_->ready_block = block;
    ui_manager_->ready_screen.set_warning(title, phrase);

    if (ui_manager_->grinding_controller_) {
        ui_manager_->grinding_controller_->update_grind_button_icon();
    }
    return block != UIManager::ReadyBlock::NONE;
}

void ReadyUIController::refresh_profiles() {
    if (!ui_manager_ || !ui_manager_->profile_controller) {
        return;
    }

    float values[USER_PROFILE_COUNT];
    for (int i = 0; i < USER_PROFILE_COUNT; ++i) {
        values[i] = get_profile_target(*ui_manager_->profile_controller, ui_manager_->current_mode, i);
    }
    ui_manager_->ready_screen.update_profile_values(values, ui_manager_->current_mode);
}

void ReadyUIController::handle_tab_change(int tab) {
    if (!ui_manager_) {
        return;
    }

    ui_manager_->current_tab = tab;
    ui_manager_->ready_screen.sync_indicator(tab);
    if (ui_manager_->profile_controller && tab < 3) {
        ui_manager_->profile_controller->set_current_profile(tab);
        refresh_profiles();
    }

    if (ui_manager_->grinding_controller_) {
        ui_manager_->grinding_controller_->update_grind_button_icon();
    }
}

void ReadyUIController::handle_profile_long_press() {
    if (!ui_manager_ || !ui_manager_->state_machine) {
        return;
    }

    if (!ui_manager_->state_machine->is_state(UIState::READY) || ui_manager_->current_tab >= 3) {
        return;
    }

    ui_manager_->original_target = get_current_profile_target(*ui_manager_->profile_controller, ui_manager_->current_mode);
    ui_manager_->edit_target = ui_manager_->original_target;
    ui_manager_->edit_screen.set_mode(ui_manager_->current_mode);
    if (ui_manager_->edit_controller_) {
        ui_manager_->edit_controller_->update_display();
    }
    ui_manager_->switch_to_state(UIState::EDIT);
}

void ReadyUIController::toggle_mode() {
    if (!ui_manager_ || ui_manager_->current_tab >= 3) {
        return;
    }

    Preferences prefs;
    prefs.begin("swipe", true); // read-only
    bool swipe_enabled = prefs.getBool("enabled", false);
    prefs.end();

    if (!swipe_enabled) {
        return;
    }

    ui_manager_->current_mode = (ui_manager_->current_mode == GrindMode::WEIGHT)
                                    ? GrindMode::TIME
                                    : GrindMode::WEIGHT;

    if (ui_manager_->profile_controller) {
        ui_manager_->profile_controller->set_grind_mode(ui_manager_->current_mode);
    }

    refresh_profiles();
    ui_manager_->edit_target = get_current_profile_target(*ui_manager_->profile_controller, ui_manager_->current_mode);
    if (ui_manager_->state_machine && ui_manager_->state_machine->is_state(UIState::EDIT)) {
        if (ui_manager_->edit_controller_) {
            ui_manager_->edit_controller_->update_display();
        }
    }

    ui_manager_->grinding_screen.set_mode(ui_manager_->current_mode);
    if (ui_manager_->state_machine &&
        (ui_manager_->state_machine->is_state(UIState::GRINDING) ||
         ui_manager_->state_machine->is_state(UIState::GRIND_COMPLETE))) {
        if (ui_manager_->grinding_controller_) {
            ui_manager_->grinding_controller_->update_grinding_targets();
        }
    }

    if (ui_manager_->grinding_controller_) {
        ui_manager_->grinding_controller_->update_grind_button_icon();
    }
}

void ReadyUIController::register_events() {
    if (!ui_manager_) {
        return;
    }

    lv_obj_t* ready_screen_obj = ui_manager_->ready_screen.get_screen();
    lv_obj_t* tabview = ui_manager_->ready_screen.get_tabview();

    if (tabview) {
        lv_obj_add_event_cb(tabview, EventBridgeLVGL::dispatch_event, LV_EVENT_VALUE_CHANGED,
                            reinterpret_cast<void*>(static_cast<intptr_t>(EventBridgeLVGL::EventType::TAB_CHANGE)));
    }

    auto gesture_handler = [](lv_event_t* e) {
        if (lv_event_get_code(e) != LV_EVENT_GESTURE) {
            return;
        }
        lv_dir_t dir = lv_indev_get_gesture_dir(lv_indev_get_act());
        if (dir != LV_DIR_TOP && dir != LV_DIR_BOTTOM) {
            return;
        }
        UIManager* ui = static_cast<UIManager*>(lv_event_get_user_data(e));
        if (ui && ui->state_machine->is_state(UIState::READY) && ui->ready_controller_) {
            ui->ready_controller_->toggle_mode();
        }
    };

    if (tabview) {
        lv_obj_add_event_cb(tabview, gesture_handler, LV_EVENT_GESTURE, ui_manager_);
    }
    if (ready_screen_obj) {
        lv_obj_add_event_cb(ready_screen_obj, gesture_handler, LV_EVENT_GESTURE, ui_manager_);
    }
    lv_obj_add_event_cb(lv_scr_act(), gesture_handler, LV_EVENT_GESTURE, ui_manager_);

    EventBridgeLVGL::register_handler(EventBridgeLVGL::EventType::TAB_CHANGE,
                                      [this](lv_event_t* event) {
                                          lv_obj_t* tabview_obj = static_cast<lv_obj_t*>(lv_event_get_target(event));
                                          uint32_t tab_id = lv_tabview_get_tab_act(tabview_obj);
                                          handle_tab_change(static_cast<int>(tab_id));
                                      });

    EventBridgeLVGL::register_handler(EventBridgeLVGL::EventType::PROFILE_LONG_PRESS,
                                      [this](lv_event_t*) { handle_profile_long_press(); });

    ui_manager_->ready_screen.set_profile_long_press_handler(EventBridgeLVGL::profile_long_press_handler);

    // The menu is reached from its own affordance now rather than by swiping
    // past the last profile onto a page pretending to be one.
    if (lv_obj_t* menu_button = ui_manager_->ready_screen.get_menu_button()) {
        lv_obj_add_event_cb(menu_button, [](lv_event_t* e) {
            if (lv_event_get_code(e) != LV_EVENT_CLICKED) return;
            auto* ui = static_cast<UIManager*>(lv_event_get_user_data(e));
            if (ui && ui->state_machine->is_state(UIState::READY)) {
                ui->switch_to_state(UIState::MENU);
            }
        }, LV_EVENT_CLICKED, ui_manager_);
    }

}
