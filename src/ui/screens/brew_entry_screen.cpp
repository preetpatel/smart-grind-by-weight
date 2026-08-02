#include "brew_entry_screen.h"
#include <cmath>
#include <cstdio>
#include "../../config/constants.h"
#include "../ui_helpers.h"

void BrewEntryScreen::create() {
    screen = lv_obj_create(lv_scr_act());
    lv_obj_set_size(screen, LV_PCT(100), LV_PCT(100));
    lv_obj_align(screen, LV_ALIGN_TOP_MID, 0, 0);
    lv_obj_set_style_bg_opa(screen, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(screen, 0, 0);
    lv_obj_set_style_pad_all(screen, 0, 0);
    lv_obj_clear_flag(screen, LV_OBJ_FLAG_SCROLLABLE);

    // Bean name, top-left; the corner X skips without recording.
    name_label = lv_label_create(screen);
    lv_label_set_text(name_label, "");
    lv_obj_set_style_text_font(name_label, &lv_font_montserrat_24, 0);
    lv_obj_set_style_text_color(name_label, lv_color_hex(THEME_COLOR_SECONDARY), 0);
    lv_label_set_long_mode(name_label, LV_LABEL_LONG_DOT);
    lv_obj_set_width(name_label, 190);
    lv_obj_align(name_label, LV_ALIGN_TOP_LEFT, 14, 28);

    skip_btn = lv_btn_create(screen);
    lv_obj_set_size(skip_btn, 52, 52);
    lv_obj_align(skip_btn, LV_ALIGN_TOP_RIGHT, -12, 14);
    lv_obj_set_style_radius(skip_btn, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_color(skip_btn, lv_color_hex(THEME_COLOR_NEUTRAL), 0);
    lv_obj_set_style_border_width(skip_btn, 0, 0);
    lv_obj_set_style_shadow_width(skip_btn, 0, 0);
    lv_obj_t* skip_icon = lv_label_create(skip_btn);
    lv_label_set_text(skip_icon, LV_SYMBOL_CLOSE);
    lv_obj_set_style_text_font(skip_icon, &lv_font_montserrat_24, 0);
    lv_obj_center(skip_icon);

    expected_label = lv_label_create(screen);
    lv_label_set_text(expected_label, "");
    lv_obj_set_style_text_font(expected_label, &lv_font_montserrat_24, 0);
    lv_obj_set_style_text_color(expected_label, lv_color_hex(THEME_COLOR_NEUTRAL), 0);
    lv_obj_align(expected_label, LV_ALIGN_TOP_MID, 0, 106);

    // Edge-mounted jog buttons flanking the yield readout.
    minus_btn = create_button(screen, LV_SYMBOL_MINUS, lv_color_hex(THEME_COLOR_PRIMARY),
                              58, 92, &lv_font_montserrat_32);
    lv_obj_align(minus_btn, LV_ALIGN_TOP_LEFT, 8, 148);

    plus_btn = create_button(screen, LV_SYMBOL_PLUS, lv_color_hex(THEME_COLOR_PRIMARY),
                             58, 92, &lv_font_montserrat_32);
    lv_obj_align(plus_btn, LV_ALIGN_TOP_RIGHT, -8, 148);

    output_label = lv_label_create(screen);
    lv_label_set_text(output_label, "0.0g");
    lv_obj_set_style_text_font(output_label, &lv_font_montserrat_48, 0);
    lv_obj_set_style_text_color(output_label, lv_color_hex(THEME_COLOR_TEXT_PRIMARY), 0);
    lv_obj_align(output_label, LV_ALIGN_TOP_MID, 0, 168);

    delta_label = lv_label_create(screen);
    lv_label_set_text(delta_label, "");
    lv_obj_set_style_text_font(delta_label, &lv_font_montserrat_24, 0);
    lv_obj_set_style_text_color(delta_label, lv_color_hex(THEME_COLOR_SUCCESS), 0);
    lv_obj_align(delta_label, LV_ALIGN_TOP_MID, 0, 266);

    done_btn = create_button(screen, "DONE", lv_color_hex(THEME_COLOR_SUCCESS),
                             264, 90, &lv_font_montserrat_32);
    lv_obj_align(done_btn, LV_ALIGN_BOTTOM_MID, 0, -10);

    visible = false;
    lv_obj_add_flag(screen, LV_OBJ_FLAG_HIDDEN);
}

void BrewEntryScreen::show() {
    lv_obj_clear_flag(screen, LV_OBJ_FLAG_HIDDEN);
    visible = true;
}

void BrewEntryScreen::hide() {
    lv_obj_add_flag(screen, LV_OBJ_FLAG_HIDDEN);
    visible = false;
}

void BrewEntryScreen::set_bean_name(const char* name) {
    if (name_label) set_label_text_if_changed(name_label, name ? name : "");
}

void BrewEntryScreen::set_values(float output_g, float expected_g) {
    char text[24];
    snprintf(text, sizeof(text), "%.1fg", output_g);
    set_label_text_if_changed(output_label, text);

    snprintf(text, sizeof(text), "expected %.1fg", expected_g);
    set_label_text_if_changed(expected_label, text);

    // Fixed shot time makes the deviation a flow signal: over means the shot
    // ran fast, under means it choked.
    float delta = output_g - expected_g;
    float band = expected_g * (USER_BREW_ON_TARGET_BAND_PCT / 100.0f);
    char delta_text[32];
    lv_color_t color;
    if (fabsf(delta) <= band) {
        snprintf(delta_text, sizeof(delta_text), "on target");
        color = lv_color_hex(THEME_COLOR_SUCCESS);
    } else if (delta > 0) {
        snprintf(delta_text, sizeof(delta_text), "+%.1fg  fast", delta);
        color = lv_color_hex(THEME_COLOR_WARNING);
    } else {
        snprintf(delta_text, sizeof(delta_text), "%.1fg  slow", delta);
        color = lv_color_hex(THEME_COLOR_ACCENT);
    }
    set_label_text_if_changed(delta_label, delta_text);
    set_label_text_color_if_changed(delta_label, color);
}
