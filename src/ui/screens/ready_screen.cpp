#include "ready_screen.h"

#include <Arduino.h>
#include <cstring>

#include "../../config/constants.h"
#include "../../controllers/grind_mode_traits.h"
#include "../../system/time_sync.h"
#include "../ui_helpers.h"
#include "../ui_icons.h"

namespace {

// The dose sits high enough that the context block has room underneath without
// either of them drifting toward the middle. Measured from the top of the
// tab page, which is the top 80% of the panel.
constexpr int kKickerTopPx = 74;
constexpr int kDotSizePx = 8;
constexpr int kDotActiveWidthPx = 22;

// The dot indicator grows and takes the accent when its profile becomes active.
// Worth animating because the gesture that caused it is itself an animation -
// a dot that snaps while the page is still sliding reads as a glitch.
const lv_style_transition_dsc_t* dot_transition() {
    static lv_style_transition_dsc_t transition;
    static lv_style_prop_t props[] = {LV_STYLE_WIDTH, LV_STYLE_BG_COLOR, LV_STYLE_PROP_INV};
    static bool initialised = false;
    if (!initialised) {
        lv_style_transition_dsc_init(&transition, props, UI_MOTION_EASE, UI_MOTION_QUICK_MS, 0, nullptr);
        initialised = true;
    }
    return &transition;
}

lv_obj_t* make_transparent_box(lv_obj_t* parent) {
    lv_obj_t* box = lv_obj_create(parent);
    lv_obj_set_style_bg_opa(box, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(box, 0, 0);
    lv_obj_set_style_pad_all(box, 0, 0);
    lv_obj_set_style_radius(box, 0, 0);
    lv_obj_clear_flag(box, LV_OBJ_FLAG_SCROLLABLE);
    return box;
}

}  // namespace

void ReadyScreen::create() {
    screen = lv_obj_create(lv_scr_act());
    lv_obj_set_size(screen, LV_PCT(100), LV_PCT(80));
    lv_obj_align(screen, LV_ALIGN_TOP_MID, 0, 0);
    lv_obj_set_style_bg_opa(screen, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(screen, 0, 0);
    lv_obj_set_style_pad_all(screen, 0, 0);
    lv_obj_add_flag(screen, LV_OBJ_FLAG_GESTURE_BUBBLE);

    tabview = lv_tabview_create(screen);
    lv_obj_set_size(tabview, LV_PCT(100), LV_PCT(100));
    lv_obj_align(tabview, LV_ALIGN_CENTER, 0, 0);
    lv_obj_add_flag(tabview, LV_OBJ_FLAG_SCROLL_CHAIN_VER);
    lv_obj_add_flag(tabview, LV_OBJ_FLAG_GESTURE_BUBBLE);

    // Swipe-only: the dots below the dose are the visible indicator instead.
    lv_obj_t* tab_btns = lv_tabview_get_tab_btns(tabview);
    lv_obj_add_flag(tab_btns, LV_OBJ_FLAG_HIDDEN);
    lv_obj_set_style_bg_opa(tabview, LV_OPA_TRANSP, 0);

    // Three tabs, three profiles. The menu used to be a fourth tab, which meant
    // swiping past Custom landed you on a page pretending to be a dose - the
    // single worst thing about the old screen. It has its own affordance now.
    profile_tabs[0] = lv_tabview_add_tab(tabview, "Single");
    profile_tabs[1] = lv_tabview_add_tab(tabview, "Double");
    profile_tabs[2] = lv_tabview_add_tab(tabview, "Custom");
    profile_tabs[3] = nullptr;
    menu_tab = nullptr;

    const char* names[3] = {"SINGLE", "DOUBLE", "CUSTOM"};
    for (int i = 0; i < 3; i++) {
        create_profile_page(profile_tabs[i], i, names[i]);
    }

    // Menu affordance: top centre, between the clock and the status icons, with
    // a hit area far larger than the mark it draws.
    menu_button = lv_obj_create(screen);
    lv_obj_set_size(menu_button, 64, 40);
    lv_obj_align(menu_button, LV_ALIGN_TOP_MID, 0, 6);
    lv_obj_set_style_bg_opa(menu_button, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(menu_button, 0, 0);
    lv_obj_set_style_pad_all(menu_button, 0, 0);
    lv_obj_clear_flag(menu_button, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_add_flag(menu_button, LV_OBJ_FLAG_CLICKABLE);

    for (int i = 0; i < 3; i++) {
        lv_obj_t* bar = lv_obj_create(menu_button);
        lv_obj_set_size(bar, 18, 2);
        lv_obj_align(bar, LV_ALIGN_CENTER, 0, (i - 1) * 6);
        lv_obj_set_style_bg_color(bar, lv_color_hex(UI_COLOR_FAINT), 0);
        lv_obj_set_style_bg_opa(bar, LV_OPA_COVER, 0);
        lv_obj_set_style_border_width(bar, 0, 0);
        lv_obj_set_style_radius(bar, 1, 0);
        lv_obj_clear_flag(bar, LV_OBJ_FLAG_SCROLLABLE);
        lv_obj_clear_flag(bar, LV_OBJ_FLAG_CLICKABLE);
    }

    // Context block: owned by the screen, not by a page, so swiping between
    // profiles slides the dose without dragging the context with it.
    context_box = make_transparent_box(screen);
    lv_obj_set_size(context_box, LV_PCT(100), LV_SIZE_CONTENT);
    lv_obj_align(context_box, LV_ALIGN_BOTTOM_MID, 0, -18);
    lv_obj_set_style_pad_hor(context_box, UI_MARGIN_PX, 0);
    lv_obj_set_layout(context_box, LV_LAYOUT_FLEX);
    lv_obj_set_flex_flow(context_box, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(context_box, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_gap(context_box, UI_CONTEXT_PHRASE_GAP_PX, 0);
    lv_obj_add_flag(context_box, LV_OBJ_FLAG_GESTURE_BUBBLE);

    context_rule = lv_obj_create(context_box);
    lv_obj_set_size(context_rule, LV_PCT(100), UI_HAIRLINE_PX);
    lv_obj_set_style_bg_color(context_rule, lv_color_hex(UI_COLOR_LINE), 0);
    lv_obj_set_style_bg_opa(context_rule, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(context_rule, 0, 0);
    lv_obj_set_style_radius(context_rule, 0, 0);
    lv_obj_set_style_margin_bottom(context_rule, 4, 0);

    for (int i = 0; i < UI_CONTEXT_MAX_PHRASES; i++) {
        context_labels[i] = lv_label_create(context_box);
        lv_label_set_text(context_labels[i], "");
        lv_obj_set_style_text_font(context_labels[i], UI_FONT_PHRASE, 0);
        lv_obj_set_style_text_color(context_labels[i], lv_color_hex(UI_COLOR_DIM), 0);
        lv_obj_add_flag(context_labels[i], LV_OBJ_FLAG_HIDDEN);
    }
    lv_obj_add_flag(context_box, LV_OBJ_FLAG_HIDDEN);

    // Corner clock: hidden until the wall clock has actually been set, so a
    // fresh boot shows nothing rather than a confident 00:00. Top-left, because
    // the top-right belongs to the BLE and warning icons.
    clock_label = lv_label_create(screen);
    lv_label_set_text(clock_label, "");
    lv_obj_set_style_text_font(clock_label, UI_FONT_BODY, 0);
    lv_obj_set_style_text_color(clock_label, lv_color_hex(UI_COLOR_FAINT), 0);
    lv_obj_align(clock_label, LV_ALIGN_TOP_LEFT, UI_MARGIN_PX, 14);
    lv_obj_add_flag(clock_label, LV_OBJ_FLAG_HIDDEN);
    clock_text[0] = '\0';

    // Warning takeover. Built once, hidden, and raised over everything when the
    // grinder cannot do what the screen would otherwise be offering. Weight
    // grinds are refused in start_grind() for a saturated or faulty load cell -
    // the screen should say so before the press, not after it.
    warning_box = make_transparent_box(screen);
    lv_obj_set_size(warning_box, LV_PCT(100), LV_PCT(100));
    lv_obj_align(warning_box, LV_ALIGN_TOP_MID, 0, 0);
    lv_obj_set_style_pad_hor(warning_box, UI_MARGIN_PX + 6, 0);
    lv_obj_set_layout(warning_box, LV_LAYOUT_FLEX);
    lv_obj_set_flex_flow(warning_box, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(warning_box, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_gap(warning_box, UI_GAP_PX, 0);

    ui_icon_warning(warning_box, UI_COLOR_WARN);

    warning_title = lv_label_create(warning_box);
    lv_label_set_text(warning_title, "");
    lv_obj_set_style_text_font(warning_title, UI_FONT_PHRASE, 0);
    lv_obj_set_style_text_color(warning_title, lv_color_hex(UI_COLOR_INK), 0);
    lv_obj_set_style_text_align(warning_title, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_long_mode(warning_title, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(warning_title, LV_PCT(100));

    warning_phrase = lv_label_create(warning_box);
    lv_label_set_text(warning_phrase, "");
    lv_obj_set_style_text_font(warning_phrase, UI_FONT_BODY, 0);
    lv_obj_set_style_text_color(warning_phrase, lv_color_hex(UI_COLOR_DIM), 0);
    lv_obj_set_style_text_align(warning_phrase, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_long_mode(warning_phrase, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(warning_phrase, LV_PCT(100));

    lv_obj_add_flag(warning_box, LV_OBJ_FLAG_HIDDEN);

    float defaults[3] = {USER_SINGLE_ESPRESSO_WEIGHT_G, USER_DOUBLE_ESPRESSO_WEIGHT_G,
                         USER_CUSTOM_PROFILE_WEIGHT_G};
    update_profile_values(defaults, GrindMode::WEIGHT);

    visible = false;
}

void ReadyScreen::set_warning(const char* title, const char* phrase) {
    if (!warning_box) return;

    const bool show = title && title[0] != '\0';
    if (show) {
        set_label_text_if_changed(warning_title, title);
        set_label_text_if_changed(warning_phrase, phrase ? phrase : "");
    }
    if (show == warning_active) {
        return;
    }
    warning_active = show;

    // The dose, the dots and the context all go: there is no point offering a
    // target the grinder will refuse to chase.
    if (show) {
        lv_obj_add_flag(tabview, LV_OBJ_FLAG_HIDDEN);
        lv_obj_add_flag(context_box, LV_OBJ_FLAG_HIDDEN);
        lv_obj_clear_flag(warning_box, LV_OBJ_FLAG_HIDDEN);
        ui_fade_in(warning_box);
    } else {
        lv_obj_add_flag(warning_box, LV_OBJ_FLAG_HIDDEN);
        lv_obj_clear_flag(tabview, LV_OBJ_FLAG_HIDDEN);
    }
}

void ReadyScreen::create_profile_page(lv_obj_t* parent, int profile_index, const char* profile_name) {
    lv_obj_set_style_pad_all(parent, 0, 0);
    lv_obj_clear_flag(parent, LV_OBJ_FLAG_SCROLLABLE);

    lv_obj_t* column = make_transparent_box(parent);
    lv_obj_set_size(column, LV_PCT(100), LV_SIZE_CONTENT);
    lv_obj_align(column, LV_ALIGN_TOP_MID, 0, kKickerTopPx);
    lv_obj_set_layout(column, LV_LAYOUT_FLEX);
    lv_obj_set_flex_flow(column, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(column, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_gap(column, UI_GAP_PX, 0);
    lv_obj_add_flag(column, LV_OBJ_FLAG_GESTURE_BUBBLE);

    kicker_labels[profile_index] = lv_label_create(column);
    lv_label_set_text(kicker_labels[profile_index], profile_name);
    lv_obj_set_style_text_font(kicker_labels[profile_index], UI_FONT_BODY, 0);
    lv_obj_set_style_text_color(kicker_labels[profile_index], lv_color_hex(UI_COLOR_DIM), 0);
    lv_obj_set_style_text_letter_space(kicker_labels[profile_index], 3, 0);
    lv_obj_add_flag(kicker_labels[profile_index], LV_OBJ_FLAG_CLICKABLE);

    // Hero row: the numerals and their unit share a baseline. The 88 px face is
    // digits-only, so the "g" has to come from the body font next to it.
    lv_obj_t* hero_row = make_transparent_box(column);
    lv_obj_set_size(hero_row, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
    lv_obj_set_layout(hero_row, LV_LAYOUT_FLEX);
    lv_obj_set_flex_flow(hero_row, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(hero_row, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_END, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_gap(hero_row, 6, 0);
    lv_obj_add_flag(hero_row, LV_OBJ_FLAG_GESTURE_BUBBLE);

    weight_labels[profile_index] = lv_label_create(hero_row);
    lv_label_set_text(weight_labels[profile_index], "0.0");
    lv_obj_set_style_text_font(weight_labels[profile_index], UI_FONT_HERO, 0);
    lv_obj_set_style_text_color(weight_labels[profile_index], lv_color_hex(UI_COLOR_INK), 0);
    lv_obj_add_flag(weight_labels[profile_index], LV_OBJ_FLAG_CLICKABLE);

    unit_labels[profile_index] = lv_label_create(hero_row);
    lv_label_set_text(unit_labels[profile_index], "g");
    lv_obj_set_style_text_font(unit_labels[profile_index], UI_FONT_UNIT, 0);
    lv_obj_set_style_text_color(unit_labels[profile_index], lv_color_hex(UI_COLOR_DIM), 0);
    // Flex bottom-aligns the boxes, which lines up descenders rather than
    // baselines. Lift the small label by the difference so "g" sits on the
    // numerals' baseline.
    lv_obj_set_style_pad_bottom(unit_labels[profile_index],
                                lv_font_hero_88.base_line - lv_font_montserrat_24.base_line, 0);

    // Profile dots. Every page draws its own set so the indicator travels with
    // the page rather than floating over the swipe.
    lv_obj_t* dot_row = make_transparent_box(column);
    lv_obj_set_size(dot_row, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
    lv_obj_set_layout(dot_row, LV_LAYOUT_FLEX);
    lv_obj_set_flex_flow(dot_row, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(dot_row, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_gap(dot_row, 8, 0);
    lv_obj_set_style_margin_top(dot_row, 6, 0);
    lv_obj_add_flag(dot_row, LV_OBJ_FLAG_GESTURE_BUBBLE);

    for (int d = 0; d < 3; d++) {
        lv_obj_t* dot = lv_obj_create(dot_row);
        lv_obj_set_size(dot, kDotSizePx, kDotSizePx);
        lv_obj_set_style_radius(dot, LV_RADIUS_CIRCLE, 0);
        lv_obj_set_style_border_width(dot, 0, 0);
        lv_obj_set_style_bg_opa(dot, LV_OPA_COVER, 0);
        lv_obj_set_style_bg_color(dot, lv_color_hex(UI_COLOR_LINE), 0);
        lv_obj_set_style_transition(dot, dot_transition(), 0);
        lv_obj_clear_flag(dot, LV_OBJ_FLAG_SCROLLABLE);
        dots[profile_index][d] = dot;
    }
    sync_dots(profile_index);
}

void ReadyScreen::sync_dots(int active_index) {
    for (int page = 0; page < 3; page++) {
        for (int d = 0; d < 3; d++) {
            if (!dots[page][d]) continue;
            const bool active = (d == active_index);
            lv_obj_set_width(dots[page][d], active ? kDotActiveWidthPx : kDotSizePx);
            lv_obj_set_style_bg_color(dots[page][d],
                                      lv_color_hex(active ? UI_COLOR_ACCENT : UI_COLOR_LINE), 0);
            lv_obj_set_style_radius(dots[page][d], LV_RADIUS_CIRCLE, 0);
        }
    }
}

void ReadyScreen::show() {
    lv_obj_clear_flag(screen, LV_OBJ_FLAG_HIDDEN);
    ui_fade_in(screen);
    visible = true;
}

void ReadyScreen::hide() {
    lv_obj_add_flag(screen, LV_OBJ_FLAG_HIDDEN);
    visible = false;
}

void ReadyScreen::update_profile_values(const float values[3], GrindMode mode) {
    const bool weight_mode = (mode == GrindMode::WEIGHT);
    for (int i = 0; i < 3; i++) {
        if (!weight_labels[i]) continue;

        // The hero font carries digits only, so the unit is split off into its
        // own label rather than living in the formatted string.
        char text[16];
        if (weight_mode) {
            snprintf(text, sizeof(text), "%.1f", values[i]);
        } else {
            snprintf(text, sizeof(text), "%.1f", values[i]);
        }
        set_label_text_if_changed(weight_labels[i], text);

        if (unit_labels[i]) {
            set_label_text_if_changed(unit_labels[i], weight_mode ? "g" : "s");
        }
    }
}

void ReadyScreen::set_active_tab(int tab) {
    if (tab < 0 || tab > 3) return;
    lv_tabview_set_act(tabview, tab, LV_ANIM_OFF);
    sync_indicator(tab);
}

void ReadyScreen::sync_indicator(int tab) {
    if (tab < 0 || tab > 3) return;
    if (tab < 3) {
        sync_dots(tab);
    }
    // The context block belongs to the dose, not to the menu page.
    if (context_box) {
        const bool has_context =
            context_labels[0] && !lv_obj_has_flag(context_labels[0], LV_OBJ_FLAG_HIDDEN);
        if (tab < 3 && has_context) {
            lv_obj_clear_flag(context_box, LV_OBJ_FLAG_HIDDEN);
        } else {
            lv_obj_add_flag(context_box, LV_OBJ_FLAG_HIDDEN);
        }
    }
}

void ReadyScreen::set_context(const char* first, const char* second) {
    if (!context_box) return;

    const char* lines[UI_CONTEXT_MAX_PHRASES] = {first, second};
    int shown = 0;

    for (int i = 0; i < UI_CONTEXT_MAX_PHRASES; i++) {
        if (!context_labels[i]) continue;
        const bool has_text = lines[i] && lines[i][0] != '\0';
        if (has_text) {
            set_label_text_if_changed(context_labels[i], lines[i]);
            lv_obj_clear_flag(context_labels[i], LV_OBJ_FLAG_HIDDEN);
            shown++;
        } else {
            lv_obj_add_flag(context_labels[i], LV_OBJ_FLAG_HIDDEN);
        }
    }

    // Nothing true to say: the whole block goes, hairline included, and the
    // screen falls back to the pure dose.
    const bool on_profile_page = tabview && lv_tabview_get_tab_act(tabview) < 3;
    if (shown > 0 && on_profile_page) {
        lv_obj_clear_flag(context_box, LV_OBJ_FLAG_HIDDEN);
    } else {
        lv_obj_add_flag(context_box, LV_OBJ_FLAG_HIDDEN);
    }
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

void ReadyScreen::set_profile_long_press_handler(lv_event_cb_t handler) {
    for (int i = 0; i < 3; i++) {
        if (weight_labels[i]) {
            lv_obj_add_event_cb(weight_labels[i], handler, LV_EVENT_LONG_PRESSED, NULL);
        }
        if (kicker_labels[i]) {
            lv_obj_add_event_cb(kicker_labels[i], handler, LV_EVENT_LONG_PRESSED, NULL);
        }
    }
}
