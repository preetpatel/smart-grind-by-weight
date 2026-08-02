#include "ready_screen.h"
#include <Arduino.h>
#include "../../config/constants.h"
#include "../../controllers/grind_mode_traits.h"
#include "../../system/bean_config.h"
#include "../../system/time_sync.h"
#include "../ui_helpers.h"

namespace {
    // What the shared chip currently shows, so its tap dismisses the right
    // message (the click callback has no per-instance context).
    bool chip_showing_bag_warning = false;
}

void ReadyScreen::create() {
    screen = lv_obj_create(lv_scr_act());
    lv_obj_set_size(screen, LV_PCT(100), LV_PCT(80));
    lv_obj_align(screen, LV_ALIGN_TOP_MID, 0, 0);
    lv_obj_set_style_bg_opa(screen, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(screen, 0, 0);
    lv_obj_set_style_pad_all(screen, 0, 0);
    lv_obj_add_flag(screen, LV_OBJ_FLAG_GESTURE_BUBBLE);

    // Create tabview
    tabview = lv_tabview_create(screen);
    lv_obj_set_size(tabview, LV_PCT(100), LV_PCT(100));
    lv_obj_align(tabview, LV_ALIGN_CENTER, 0, 0);
    lv_obj_add_flag(tabview, LV_OBJ_FLAG_SCROLL_CHAIN_VER);
    lv_obj_add_flag(tabview, LV_OBJ_FLAG_GESTURE_BUBBLE);

    // Hide tab buttons for swipe-only interface
    lv_obj_t* tab_btns = lv_tabview_get_tab_btns(tabview);
    lv_obj_add_flag(tab_btns, LV_OBJ_FLAG_HIDDEN);

    // Transparent background
    lv_obj_set_style_bg_opa(tabview, LV_OPA_TRANSP, 0);

    // Add profile tabs
    profile_tabs[0] = lv_tabview_add_tab(tabview, "Single");
    profile_tabs[1] = lv_tabview_add_tab(tabview, "Double");
    profile_tabs[2] = lv_tabview_add_tab(tabview, "Custom");
    menu_tab = lv_tabview_add_tab(tabview, "MENU");
    profile_tabs[3] = menu_tab;

    // Default weights
    float default_weights[3] = {USER_SINGLE_ESPRESSO_WEIGHT_G, USER_DOUBLE_ESPRESSO_WEIGHT_G, USER_CUSTOM_PROFILE_WEIGHT_G};
    const char* names[3] = {"SINGLE", "DOUBLE", "CUSTOM"};
    
    for (int i = 0; i < 3; i++) {
        create_profile_page(profile_tabs[i], i, names[i], default_weights[i]);
    }

    // Create menu tab page
    create_menu_page(menu_tab);

    // Corner clock: stays hidden until the wall clock has synced over BLE, so
    // drift is visible day-to-day without a bogus 00:00 on fresh boots.
    // Top-left — the top-right corner belongs to the BLE + warning status
    // icons (see status_indicator_controller.cpp).
    clock_label = lv_label_create(screen);
    lv_label_set_text(clock_label, "");
    lv_obj_set_style_text_font(clock_label, &lv_font_montserrat_24, 0);
    lv_obj_set_style_text_color(clock_label, lv_color_hex(THEME_COLOR_TEXT_SECONDARY), 0);
    lv_obj_align(clock_label, LV_ALIGN_TOP_LEFT, 10, 10);
    lv_obj_add_flag(clock_label, LV_OBJ_FLAG_HIDDEN);
    clock_text[0] = '\0';

    // Grind advice chip: the server's finer/coarser verdict, shown where the
    // user stands before dialing the next shot. Sits at the bottom of this
    // 80%-height container, clear of the floating grind button below it.
    // Tap to dismiss until the verdict changes.
    advice_chip = lv_obj_create(screen);
    lv_obj_set_size(advice_chip, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
    lv_obj_align(advice_chip, LV_ALIGN_BOTTOM_MID, 0, -2);
    lv_obj_set_style_bg_color(advice_chip, lv_color_hex(0x202020), 0);
    lv_obj_set_style_bg_opa(advice_chip, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(advice_chip, THEME_CORNER_RADIUS_PX, 0);
    lv_obj_set_style_border_width(advice_chip, 0, 0);
    lv_obj_set_style_pad_ver(advice_chip, 12, 0);
    lv_obj_set_style_pad_hor(advice_chip, 18, 0);
    lv_obj_set_layout(advice_chip, LV_LAYOUT_FLEX);
    lv_obj_set_flex_flow(advice_chip, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(advice_chip, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_gap(advice_chip, 10, 0);
    lv_obj_clear_flag(advice_chip, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_add_flag(advice_chip, LV_OBJ_FLAG_CLICKABLE);

    lv_obj_t* advice_dot = lv_obj_create(advice_chip);
    lv_obj_set_size(advice_dot, 10, 10);
    lv_obj_set_style_radius(advice_dot, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_color(advice_dot, lv_color_hex(THEME_COLOR_WARNING), 0);
    lv_obj_set_style_border_width(advice_dot, 0, 0);

    advice_label = lv_label_create(advice_chip);
    lv_label_set_text(advice_label, "");
    lv_obj_set_style_text_font(advice_label, &lv_font_montserrat_24, 0);
    lv_obj_set_style_text_color(advice_label, lv_color_hex(THEME_COLOR_TEXT_PRIMARY), 0);

    lv_obj_add_event_cb(advice_chip, [](lv_event_t* e) {
        if (lv_event_get_code(e) != LV_EVENT_CLICKED) return;
        if (chip_showing_bag_warning) {
            bean_config.dismiss_bag_warning();
        } else {
            bean_config.dismiss_advice();
        }
        lv_obj_add_flag(static_cast<lv_obj_t*>(lv_event_get_target(e)), LV_OBJ_FLAG_HIDDEN);
    }, LV_EVENT_CLICKED, nullptr);

    lv_obj_add_flag(advice_chip, LV_OBJ_FLAG_HIDDEN);

    update_profile_values(default_weights, GrindMode::WEIGHT);

    visible = false;
}

void ReadyScreen::update_advice_chip() {
    if (!advice_chip || !advice_label) return;
    bean_config.reload_if_dirty();

    // The bag running out outranks dial-in advice: it is about to interrupt
    // the routine, and the advice will still be true on the next bag's shots.
    if (bean_config.is_bag_low() && !bean_config.is_bag_warning_dismissed()) {
        int16_t shots = bean_config.get_shots_remaining();
        char text[24];
        if (shots <= 0) {
            snprintf(text, sizeof(text), "BAG EMPTY");
        } else {
            snprintf(text, sizeof(text), "%d SHOT%s LEFT", shots, shots == 1 ? "" : "S");
        }
        chip_showing_bag_warning = true;
        set_label_text_if_changed(advice_label, text);
        lv_obj_clear_flag(advice_chip, LV_OBJ_FLAG_HIDDEN);
        return;
    }

    BeanConfig::Advice advice = bean_config.get_advice();
    bool actionable = (advice == BeanConfig::Advice::FINER || advice == BeanConfig::Advice::COARSER)
                      && !bean_config.is_advice_dismissed();
    if (!actionable) {
        lv_obj_add_flag(advice_chip, LV_OBJ_FLAG_HIDDEN);
        return;
    }
    chip_showing_bag_warning = false;
    set_label_text_if_changed(advice_label,
                              advice == BeanConfig::Advice::FINER ? "TRY FINER" : "TRY COARSER");
    lv_obj_clear_flag(advice_chip, LV_OBJ_FLAG_HIDDEN);
}

void ReadyScreen::update_clock() {
    if (!clock_label) return;
    if (!TimeSync::is_synced()) {
        lv_obj_add_flag(clock_label, LV_OBJ_FLAG_HIDDEN);
        return;
    }
    char text[sizeof(clock_text)];
    TimeSync::format_local_clock(text, sizeof(text));
    if (strcmp(text, clock_text) != 0) {
        strncpy(clock_text, text, sizeof(clock_text) - 1);
        clock_text[sizeof(clock_text) - 1] = '\0';
        lv_label_set_text(clock_label, clock_text);
    }
    lv_obj_clear_flag(clock_label, LV_OBJ_FLAG_HIDDEN);
}

void ReadyScreen::create_profile_page(lv_obj_t* parent, int profile_index, const char* profile_name, float weight) {
    lv_obj_set_layout(parent, LV_LAYOUT_FLEX);
    lv_obj_set_flex_flow(parent, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(parent, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_gap(parent, 0, 0);

    lv_obj_t* name_label;
    (void)create_profile_label(parent, &name_label, &weight_labels[profile_index]);
    lv_label_set_text(name_label, profile_name);
    lv_obj_add_flag(name_label, LV_OBJ_FLAG_CLICKABLE);
    
    char weight_text[16];
    snprintf(weight_text, sizeof(weight_text), SYS_WEIGHT_DISPLAY_FORMAT, weight);
    lv_label_set_text(weight_labels[profile_index], weight_text);
    lv_obj_add_flag(weight_labels[profile_index], LV_OBJ_FLAG_CLICKABLE);
}

void ReadyScreen::create_menu_page(lv_obj_t* parent) {
    lv_obj_set_layout(parent, LV_LAYOUT_FLEX);
    lv_obj_set_flex_flow(parent, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(parent, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_gap(parent, 20, 0);

    // Info label
    lv_obj_t* info_label = lv_label_create(parent);
    lv_label_set_text(info_label, "MAIN\nMENU");
    lv_obj_set_style_text_font(info_label, &lv_font_montserrat_32, 0);
    lv_obj_set_style_text_color(info_label, lv_color_hex(THEME_COLOR_TEXT_PRIMARY), 0);
    lv_obj_set_style_text_align(info_label, LV_TEXT_ALIGN_CENTER, 0);
}

void ReadyScreen::show() {
    lv_obj_clear_flag(screen, LV_OBJ_FLAG_HIDDEN);
    visible = true;
}

void ReadyScreen::hide() {
    lv_obj_add_flag(screen, LV_OBJ_FLAG_HIDDEN);
    visible = false;
}

void ReadyScreen::update_profile_values(const float values[3], GrindMode mode) {
    for (int i = 0; i < 3; i++) {
        if (weight_labels[i]) {
            char text[24];
            format_ready_value(text, sizeof(text), mode, values[i]);
            lv_label_set_text(weight_labels[i], text);
        }
    }
}

void ReadyScreen::set_active_tab(int tab) {
    if (tab >= 0 && tab < 4) {
        lv_tabview_set_act(tabview, tab, LV_ANIM_OFF);
    }
}

void ReadyScreen::set_profile_long_press_handler(lv_event_cb_t handler) {
    for (int i = 0; i < 3; i++) {
        if (weight_labels[i]) {
            lv_obj_add_event_cb(weight_labels[i], handler, LV_EVENT_LONG_PRESSED, NULL);
        }
    }
}
