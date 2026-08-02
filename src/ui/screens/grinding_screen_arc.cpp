#include "grinding_screen_arc.h"

#include <Arduino.h>

#include "../../config/constants.h"
#include "../ui_helpers.h"

namespace {

// The arc has to clear both side margins, and the weight has to fit inside it.
// 232 px leaves 24 px a side; the 60 px hero measures about 130 px wide at
// "14.2", which sits comfortably within the 200 px of clear space inside.
constexpr int kArcDiameterPx = 232;
constexpr int kArcStrokePx = 6;

}  // namespace

void GrindingScreenArc::create() {
    screen = lv_obj_create(lv_scr_act());
    lv_obj_set_size(screen, LV_PCT(100), LV_PCT(80));
    lv_obj_align(screen, LV_ALIGN_TOP_MID, 0, 0);
    lv_obj_set_style_bg_opa(screen, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(screen, 0, 0);
    lv_obj_set_style_pad_all(screen, 0, 0);
    lv_obj_clear_flag(screen, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_add_flag(screen, LV_OBJ_FLAG_CLICKABLE);  // Tap toggles to the chart layout

    // Kicker: which profile is running. Same size and colour as the ready
    // screen's kicker, so the eye keeps its place through the transition.
    profile_label = lv_label_create(screen);
    lv_label_set_text(profile_label, "DOUBLE");
    lv_obj_set_style_text_font(profile_label, UI_FONT_BODY, 0);
    lv_obj_set_style_text_color(profile_label, lv_color_hex(UI_COLOR_DIM), 0);
    lv_obj_set_style_text_letter_space(profile_label, 3, 0);
    lv_obj_align(profile_label, LV_ALIGN_TOP_MID, 0, 34);

    // The arc is the one moving thing on the screen and the only coloured one.
    progress_arc = lv_arc_create(screen);
    lv_obj_set_size(progress_arc, kArcDiameterPx, kArcDiameterPx);
    lv_obj_align(progress_arc, LV_ALIGN_TOP_MID, 0, 84);
    lv_arc_set_range(progress_arc, 0, 100);
    lv_arc_set_value(progress_arc, 0);
    lv_obj_set_style_arc_color(progress_arc, lv_color_hex(UI_COLOR_LINE), LV_PART_MAIN);
    lv_obj_set_style_arc_width(progress_arc, kArcStrokePx, LV_PART_MAIN);
    lv_obj_set_style_arc_color(progress_arc, lv_color_hex(UI_COLOR_ACCENT), LV_PART_INDICATOR);
    lv_obj_set_style_arc_width(progress_arc, kArcStrokePx, LV_PART_INDICATOR);
    lv_obj_set_style_arc_rounded(progress_arc, true, LV_PART_INDICATOR);
    lv_obj_set_style_bg_opa(progress_arc, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(progress_arc, 0, 0);
    lv_obj_remove_style(progress_arc, nullptr, LV_PART_KNOB);
    lv_obj_clear_flag(progress_arc, LV_OBJ_FLAG_CLICKABLE);

    // Live weight, centred in the arc, with its unit on the same baseline.
    lv_obj_t* weight_row = lv_obj_create(progress_arc);
    lv_obj_set_size(weight_row, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
    lv_obj_set_style_bg_opa(weight_row, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(weight_row, 0, 0);
    lv_obj_set_style_pad_all(weight_row, 0, 0);
    lv_obj_clear_flag(weight_row, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_clear_flag(weight_row, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_set_layout(weight_row, LV_LAYOUT_FLEX);
    lv_obj_set_flex_flow(weight_row, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(weight_row, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_END, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_gap(weight_row, 5, 0);
    lv_obj_center(weight_row);

    weight_label = lv_label_create(weight_row);
    lv_label_set_text(weight_label, "0.0");
    lv_obj_set_style_text_font(weight_label, UI_FONT_HERO_SMALL, 0);
    lv_obj_set_style_text_color(weight_label, lv_color_hex(UI_COLOR_INK), 0);

    unit_label = lv_label_create(weight_row);
    lv_label_set_text(unit_label, "g");
    lv_obj_set_style_text_font(unit_label, UI_FONT_UNIT, 0);
    lv_obj_set_style_text_color(unit_label, lv_color_hex(UI_COLOR_DIM), 0);
    lv_obj_set_style_pad_bottom(unit_label,
                                lv_font_hero_60.base_line - lv_font_montserrat_24.base_line, 0);

    // The phrase under the arc: the target while running, the verdict when done.
    // One line, never a label/value pair - see ui_tokens.h.
    target_label = lv_label_create(screen);
    lv_label_set_text(target_label, "of 18.0 g");
    lv_obj_set_style_text_font(target_label, UI_FONT_PHRASE, 0);
    lv_obj_set_style_text_color(target_label, lv_color_hex(UI_COLOR_FAINT), 0);
    lv_label_set_long_mode(target_label, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(target_label, HW_DISPLAY_WIDTH_PX - (2 * UI_MARGIN_PX));
    lv_obj_set_style_text_align(target_label, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_align(target_label, LV_ALIGN_TOP_MID, 0, 84 + kArcDiameterPx + 18);

    // Children must not swallow the tap that toggles the layout.
    for (uint32_t i = 0; i < lv_obj_get_child_cnt(screen); i++) {
        lv_obj_clear_flag(lv_obj_get_child(screen, i), LV_OBJ_FLAG_CLICKABLE);
    }

    visible = false;
    time_mode = false;
    lv_obj_add_flag(screen, LV_OBJ_FLAG_HIDDEN);
}

void GrindingScreenArc::show() {
    lv_obj_clear_flag(screen, LV_OBJ_FLAG_HIDDEN);
    visible = true;
}

void GrindingScreenArc::hide() {
    lv_obj_add_flag(screen, LV_OBJ_FLAG_HIDDEN);
    visible = false;
}

void GrindingScreenArc::update_profile_name(const char* name) {
    set_label_text_if_changed(profile_label, name);
}

void GrindingScreenArc::update_target_weight(float weight) {
    if (time_mode) {
        return;
    }
    char text[32];
    snprintf(text, sizeof(text), "of %.1f g", static_cast<double>(weight));
    set_label_text_if_changed(target_label, text);
    set_label_text_color_if_changed(target_label, lv_color_hex(UI_COLOR_FAINT));
}

void GrindingScreenArc::update_target_weight_text(const char* text) {
    set_label_text_if_changed(target_label, text);
}

void GrindingScreenArc::update_target_time(float seconds) {
    char text[32];
    snprintf(text, sizeof(text), "for %.1f s", static_cast<double>(seconds));
    set_label_text_if_changed(target_label, text);
}

void GrindingScreenArc::update_current_weight(float weight) {
    char text[16];
    snprintf(text, sizeof(text), "%.1f", static_cast<double>(weight));
    set_label_text_if_changed(weight_label, text);
    set_label_text_if_changed(unit_label, time_mode ? "s" : "g");
    if (lv_obj_has_flag(unit_label, LV_OBJ_FLAG_HIDDEN)) {
        lv_obj_clear_flag(unit_label, LV_OBJ_FLAG_HIDDEN);
    }
}

void GrindingScreenArc::update_tare_display() {
    // "TARE" is a word, not a measurement, so the unit is dropped rather than
    // left dangling next to it.
    set_label_text_if_changed(weight_label, "TARE");
    lv_obj_add_flag(unit_label, LV_OBJ_FLAG_HIDDEN);
    lv_arc_set_value(progress_arc, 0);
}

void GrindingScreenArc::update_progress(int percent) {
    lv_arc_set_value(progress_arc, percent);
}

void GrindingScreenArc::set_result_tone(ResultTone tone) {
    uint32_t arc_color = UI_COLOR_ACCENT;
    uint32_t phrase_color = UI_COLOR_FAINT;

    if (tone == ResultTone::GOOD) {
        arc_color = UI_COLOR_OK;
        phrase_color = UI_COLOR_OK;
    } else if (tone == ResultTone::BAD) {
        arc_color = UI_COLOR_BAD;
        phrase_color = UI_COLOR_BAD;
    }

    lv_obj_set_style_arc_color(progress_arc, lv_color_hex(arc_color), LV_PART_INDICATOR);
    set_label_text_color_if_changed(target_label, lv_color_hex(phrase_color));
}

void GrindingScreenArc::set_time_mode(bool enabled) {
    time_mode = enabled;
}
