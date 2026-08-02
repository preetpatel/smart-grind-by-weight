#include "idle_screen.h"

#include <cstring>

#include "../../config/constants.h"
#include "../../system/time_sync.h"
#include "../ui_helpers.h"

namespace {
    // Eight positions around a square ring. Walking them in order moves the face
    // gradually rather than teleporting it across the screen, which reads as a
    // still image drifting rather than as a glitch.
    constexpr int8_t kShiftOffsets[][2] = {
        {0, -1}, {1, -1}, {1, 0}, {1, 1}, {0, 1}, {-1, 1}, {-1, 0}, {-1, -1}
    };
    constexpr int kShiftPositionCount = sizeof(kShiftOffsets) / sizeof(kShiftOffsets[0]);
}

void IdleScreen::create() {
    screen = lv_obj_create(lv_scr_act());
    lv_obj_set_size(screen, LV_PCT(100), LV_PCT(100));
    lv_obj_align(screen, LV_ALIGN_TOP_MID, 0, 0);
#if defined(DEBUG_ENABLE_LOADCELL_MOCK) && (DEBUG_ENABLE_LOADCELL_MOCK != 0)
    lv_obj_set_style_bg_color(screen, lv_color_hex(THEME_COLOR_BACKGROUND_MOCK), 0);
#else
    lv_obj_set_style_bg_color(screen, lv_color_hex(THEME_COLOR_BACKGROUND), 0);
#endif
    lv_obj_set_style_bg_opa(screen, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(screen, 0, 0);
    lv_obj_set_style_radius(screen, 0, 0);
    lv_obj_set_style_pad_all(screen, 0, 0);
    lv_obj_clear_flag(screen, LV_OBJ_FLAG_SCROLLABLE);
    // Clickable so the tap that wakes the grinder is consumed here rather than
    // landing on the profile tab or grind button sitting underneath.
    lv_obj_add_flag(screen, LV_OBJ_FLAG_CLICKABLE);

    content = lv_obj_create(screen);
    lv_obj_set_size(content, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
    lv_obj_set_style_bg_opa(content, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(content, 0, 0);
    lv_obj_set_style_pad_all(content, 0, 0);
    lv_obj_set_style_pad_gap(content, 8, 0);
    lv_obj_clear_flag(content, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_layout(content, LV_LAYOUT_FLEX);
    lv_obj_set_flex_flow(content, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(content, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_END, LV_FLEX_ALIGN_CENTER);

    time_label = lv_label_create(content);
    lv_label_set_text(time_label, "");
    lv_obj_set_style_text_font(time_label, &lv_font_montserrat_60, 0);
    lv_obj_set_style_text_color(time_label, lv_color_hex(THEME_COLOR_TEXT_PRIMARY), 0);

    meridiem_label = lv_label_create(content);
    lv_label_set_text(meridiem_label, "");
    lv_obj_set_style_text_font(meridiem_label, &lv_font_montserrat_24, 0);
    lv_obj_set_style_text_color(meridiem_label, lv_color_hex(THEME_COLOR_TEXT_SECONDARY), 0);
    // Flex bottom-aligns the two boxes, which lines up their descenders rather than
    // their baselines. Lifting the small label by the difference in descent puts
    // "AM" on the same baseline as the digits.
    lv_obj_set_style_pad_bottom(meridiem_label,
                                lv_font_montserrat_60.base_line - lv_font_montserrat_24.base_line, 0);

    lv_obj_align(content, LV_ALIGN_CENTER, 0, 0);

    hide();
}

void IdleScreen::show() {
    if (!screen) return;
    lv_obj_clear_flag(screen, LV_OBJ_FLAG_HIDDEN);
    visible = true;
}

void IdleScreen::hide() {
    if (!screen) return;
    lv_obj_add_flag(screen, LV_OBJ_FLAG_HIDDEN);
    visible = false;
}

void IdleScreen::update(uint32_t now_ms) {
    if (!visible || !screen) return;
    update_time();
    update_shift(now_ms);
}

void IdleScreen::update_time() {
    // Formatted through TimeSync so the 12/24-hour preference and the leading-zero
    // handling stay in one place, then split so the meridiem can be set small.
    char formatted[12];
    TimeSync::format_local_clock(formatted, sizeof(formatted));
    if (formatted[0] == '\0') {
        return;  // Never synced - the controller does not raise the face in that case
    }

    const char* meridiem = "";
    if (char* space = strchr(formatted, ' ')) {
        *space = '\0';
        meridiem = space + 1;
    }

    set_label_text_if_changed(time_label, formatted);
    set_label_text_if_changed(meridiem_label, meridiem);

    const bool hide_meridiem = (meridiem[0] == '\0');
    if (hide_meridiem != lv_obj_has_flag(meridiem_label, LV_OBJ_FLAG_HIDDEN)) {
        if (hide_meridiem) {
            lv_obj_add_flag(meridiem_label, LV_OBJ_FLAG_HIDDEN);
        } else {
            lv_obj_clear_flag(meridiem_label, LV_OBJ_FLAG_HIDDEN);
        }
    }
}

void IdleScreen::update_shift(uint32_t now_ms) {
    const int index = static_cast<int>((now_ms / USER_IDLE_CLOCK_SHIFT_INTERVAL_MS) % kShiftPositionCount);
    if (index == shift_index) {
        return;
    }
    shift_index = index;

    lv_obj_align(content, LV_ALIGN_CENTER,
                 kShiftOffsets[index][0] * USER_IDLE_CLOCK_SHIFT_PX,
                 kShiftOffsets[index][1] * USER_IDLE_CLOCK_SHIFT_PX);
}
