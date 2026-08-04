#include "brew_entry_screen.h"
#include <cmath>
#include <cstdio>
#include "../../config/constants.h"
#include "../ui_helpers.h"

namespace {
    // Layout, in screen pixels. The top 48 belong to the status icon row.
    constexpr lv_coord_t kNameTop = 56;
    constexpr lv_coord_t kValueTop = 100;
    constexpr lv_coord_t kTrackTop = 196;
    constexpr lv_coord_t kTrackLeft = 22;
    constexpr lv_coord_t kTrackWidth = 236;
    constexpr lv_coord_t kTrackHeight = 8;
    constexpr lv_coord_t kMarkerWidth = 12;
    constexpr lv_coord_t kMarkerHeight = 20;
    constexpr lv_coord_t kEdgeLabelTop = 214;
    constexpr lv_coord_t kJogTop = 250;
    constexpr lv_coord_t kJogWidth = 128;
    constexpr lv_coord_t kJogHeight = 84;
    constexpr lv_coord_t kDotsTop = 342;
    constexpr lv_coord_t kCommitTop = 356;
    constexpr lv_coord_t kCommitHeight = 90;
    constexpr lv_coord_t kSkipWidth = 84;
    constexpr lv_coord_t kDoneWidth = 172;
    constexpr lv_coord_t kEdgeInset = 8;

    // The value gets all 264px between the margins, so montserrat_60 holds at
    // every value the clamp allows ("500.0g" is 208px).
    constexpr lv_coord_t kValueMaxWidth = 264;

    // The band widened by its own width on each side, so a value outside the
    // recipe still lands somewhere readable instead of pinned to an end stop.
    float track_fraction(float value, float lo, float hi) {
        float pad = hi - lo;
        float scale_lo = lo - pad;
        float span = (hi + pad) - scale_lo;
        if (!(span > 0.0f)) return 0.5f;
        float t = (value - scale_lo) / span;
        if (t < 0.0f) return 0.0f;
        if (t > 1.0f) return 1.0f;
        return t;
    }

    // In range is the normal case, so the value stays white - colour marks the
    // exception. Under-range reads as a slow shot, over as a fast one.
    uint32_t verdict_colour(float value, float lo, float hi) {
        if (value < lo) return THEME_COLOR_ACCENT;
        if (value > hi) return THEME_COLOR_WARNING;
        return THEME_COLOR_SUCCESS;
    }
}

void BrewEntryScreen::create() {
    screen = lv_obj_create(lv_scr_act());
    lv_obj_set_size(screen, LV_PCT(100), LV_PCT(100));
    lv_obj_align(screen, LV_ALIGN_TOP_MID, 0, 0);
    lv_obj_set_style_bg_opa(screen, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(screen, 0, 0);
    lv_obj_set_style_pad_all(screen, 0, 0);
    lv_obj_clear_flag(screen, LV_OBJ_FLAG_SCROLLABLE);

    // Bean name on its own line below the status band, where it gets 248px.
    // Beside the icons it had 170, and "Atomic Veloce" alone is 175.
    name_label = lv_label_create(screen);
    lv_label_set_text(name_label, "");
    lv_obj_set_style_text_font(name_label, &lv_font_montserrat_24, 0);
    lv_obj_set_style_text_color(name_label, lv_color_hex(THEME_COLOR_SECONDARY), 0);
    lv_label_set_long_mode(name_label, LV_LABEL_LONG_DOT);
    lv_obj_set_width(name_label, 248);
    lv_obj_align(name_label, LV_ALIGN_TOP_LEFT, 16, kNameTop);

    value_label = lv_label_create(screen);
    lv_label_set_text(value_label, "0.0g");
    lv_obj_set_style_text_font(value_label, &lv_font_montserrat_60, 0);
    lv_obj_set_style_text_color(value_label, lv_color_hex(THEME_COLOR_TEXT_PRIMARY), 0);
    lv_obj_set_style_text_align(value_label, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_width(value_label, kValueMaxWidth);
    lv_obj_align(value_label, LV_ALIGN_TOP_MID, 0, kValueTop);

    track = lv_obj_create(screen);
    lv_obj_set_size(track, kTrackWidth, kTrackHeight);
    lv_obj_align(track, LV_ALIGN_TOP_LEFT, kTrackLeft, kTrackTop);
    lv_obj_set_style_bg_color(track, lv_color_hex(0x232323), 0);
    lv_obj_set_style_bg_opa(track, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(track, kTrackHeight / 2, 0);
    lv_obj_set_style_border_width(track, 0, 0);
    lv_obj_set_style_pad_all(track, 0, 0);
    lv_obj_clear_flag(track, LV_OBJ_FLAG_SCROLLABLE);

    track_band = lv_obj_create(screen);
    lv_obj_set_size(track_band, 0, kTrackHeight);
    lv_obj_set_style_bg_color(track_band, lv_color_hex(THEME_COLOR_SUCCESS), 0);
    lv_obj_set_style_bg_opa(track_band, LV_OPA_40, 0);
    lv_obj_set_style_radius(track_band, 0, 0);
    lv_obj_set_style_border_width(track_band, 0, 0);
    lv_obj_set_style_pad_all(track_band, 0, 0);
    lv_obj_clear_flag(track_band, LV_OBJ_FLAG_SCROLLABLE);

    track_marker = lv_obj_create(screen);
    lv_obj_set_size(track_marker, kMarkerWidth, kMarkerHeight);
    lv_obj_set_style_radius(track_marker, kMarkerWidth / 2, 0);
    lv_obj_set_style_border_width(track_marker, 0, 0);
    lv_obj_set_style_pad_all(track_marker, 0, 0);
    lv_obj_clear_flag(track_marker, LV_OBJ_FLAG_SCROLLABLE);

    edge_lo_label = lv_label_create(screen);
    lv_label_set_text(edge_lo_label, "");
    lv_obj_set_style_text_font(edge_lo_label, &lv_font_montserrat_16, 0);
    lv_obj_set_style_text_color(edge_lo_label, lv_color_hex(THEME_COLOR_SECONDARY), 0);
    lv_obj_align(edge_lo_label, LV_ALIGN_TOP_LEFT, kTrackLeft, kEdgeLabelTop);

    edge_hi_label = lv_label_create(screen);
    lv_label_set_text(edge_hi_label, "");
    lv_obj_set_style_text_font(edge_hi_label, &lv_font_montserrat_16, 0);
    lv_obj_set_style_text_color(edge_hi_label, lv_color_hex(THEME_COLOR_SECONDARY), 0);
    lv_obj_align(edge_hi_label, LV_ALIGN_TOP_RIGHT, -kTrackLeft, kEdgeLabelTop);

    hint_label = lv_label_create(screen);
    lv_label_set_text(hint_label, "");
    lv_obj_set_style_text_font(hint_label, &lv_font_montserrat_16, 0);
    lv_obj_set_style_text_color(hint_label, lv_color_hex(THEME_COLOR_SECONDARY), 0);
    lv_obj_set_style_text_align(hint_label, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_width(hint_label, LV_PCT(100));
    lv_obj_align(hint_label, LV_ALIGN_TOP_MID, 0, kEdgeLabelTop);

    minus_btn = create_button(screen, LV_SYMBOL_MINUS, lv_color_hex(THEME_COLOR_PRIMARY),
                              kJogWidth, kJogHeight, &lv_font_montserrat_32);
    lv_obj_align(minus_btn, LV_ALIGN_TOP_LEFT, kEdgeInset, kJogTop);

    plus_btn = create_button(screen, LV_SYMBOL_PLUS, lv_color_hex(THEME_COLOR_PRIMARY),
                             kJogWidth, kJogHeight, &lv_font_montserrat_32);
    lv_obj_align(plus_btn, LV_ALIGN_TOP_RIGHT, -kEdgeInset, kJogTop);

    // Two dots are the only step chrome; the unit and NEXT/DONE carry the rest.
    for (int i = 0; i < 2; i++) {
        step_dots[i] = lv_obj_create(screen);
        lv_obj_set_size(step_dots[i], 7, 7);
        lv_obj_set_style_radius(step_dots[i], LV_RADIUS_CIRCLE, 0);
        lv_obj_set_style_border_width(step_dots[i], 0, 0);
        lv_obj_align(step_dots[i], LV_ALIGN_TOP_MID, i == 0 ? -7 : 7, kDotsTop);
    }

    // Commit row in the house dual-button grammar (edit, purge confirm), sized
    // to encode priority. Replaces the corner X, which sat on the status icons.
    skip_btn = create_button(screen, LV_SYMBOL_CLOSE, lv_color_hex(THEME_COLOR_NEUTRAL),
                             kSkipWidth, kCommitHeight, &lv_font_montserrat_32);
    lv_obj_align(skip_btn, LV_ALIGN_TOP_LEFT, kEdgeInset, kCommitTop);

    done_btn = create_button(screen, "DONE", lv_color_hex(THEME_COLOR_SUCCESS),
                             kDoneWidth, kCommitHeight, &lv_font_montserrat_32);
    lv_obj_align(done_btn, LV_ALIGN_TOP_RIGHT, -kEdgeInset, kCommitTop);
    done_label = lv_obj_get_child(done_btn, -1);

    set_step(Step::YIELD);

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

void BrewEntryScreen::set_step(Step step) {
    bool on_yield = (step == Step::YIELD);
    if (done_label) set_label_text_if_changed(done_label, on_yield ? "NEXT" : "DONE");
    for (int i = 0; i < 2; i++) {
        if (!step_dots[i]) continue;
        bool active = (i == 0) == on_yield;
        lv_obj_set_style_bg_color(step_dots[i],
                                  lv_color_hex(active ? THEME_COLOR_TEXT_PRIMARY : 0x3A3A3A), 0);
    }
}

namespace {
    void set_hidden(lv_obj_t* object, bool hidden) {
        if (!object) return;
        if (hidden) {
            lv_obj_add_flag(object, LV_OBJ_FLAG_HIDDEN);
        } else {
            lv_obj_clear_flag(object, LV_OBJ_FLAG_HIDDEN);
        }
    }
}

void BrewEntryScreen::set_track_visible(bool shown) {
    set_hidden(track, !shown);
    set_hidden(track_band, !shown);
    set_hidden(track_marker, !shown);
}

void BrewEntryScreen::set_edges_visible(bool shown) {
    set_hidden(edge_lo_label, !shown);
    set_hidden(edge_hi_label, !shown);
    set_hidden(hint_label, shown);
}

void BrewEntryScreen::set_value(Step step, float value, float lo, float hi, const char* hint) {
    char text[24];
    if (step == Step::YIELD) {
        snprintf(text, sizeof(text), "%.1fg", value);
    } else {
        snprintf(text, sizeof(text), "%ds", (int)lroundf(value));
    }
    set_label_text_if_changed(value_label, text);

    bool has_hint = (hint != nullptr && hint[0] != '\0');
    if (has_hint) set_label_text_if_changed(hint_label, hint);
    set_edges_visible(!has_hint);

    bool banded = (hi > lo);
    set_track_visible(banded);
    if (!banded) {
        set_label_text_color_if_changed(value_label, lv_color_hex(THEME_COLOR_TEXT_PRIMARY));
        return;
    }

    uint32_t colour = verdict_colour(value, lo, hi);
    // White while inside the band: colour is for the exception, not the norm.
    bool outside = (value < lo || value > hi);
    set_label_text_color_if_changed(value_label,
                                    lv_color_hex(outside ? colour : THEME_COLOR_TEXT_PRIMARY));

    float band_start = track_fraction(lo, lo, hi);
    float band_end = track_fraction(hi, lo, hi);
    lv_coord_t band_x = kTrackLeft + (lv_coord_t)lroundf(band_start * kTrackWidth);
    lv_coord_t band_w = (lv_coord_t)lroundf((band_end - band_start) * kTrackWidth);
    lv_obj_set_size(track_band, band_w, kTrackHeight);
    lv_obj_align(track_band, LV_ALIGN_TOP_LEFT, band_x, kTrackTop);

    lv_coord_t marker_x = kTrackLeft
                          + (lv_coord_t)lroundf(track_fraction(value, lo, hi) * kTrackWidth)
                          - kMarkerWidth / 2;
    lv_obj_align(track_marker, LV_ALIGN_TOP_LEFT, marker_x, kTrackTop - (kMarkerHeight - kTrackHeight) / 2);
    lv_obj_set_style_bg_color(track_marker, lv_color_hex(colour), 0);

    if (has_hint) return;
    if (step == Step::YIELD) {
        snprintf(text, sizeof(text), "%.1f", lo);
        set_label_text_if_changed(edge_lo_label, text);
        snprintf(text, sizeof(text), "%.1f", hi);
        set_label_text_if_changed(edge_hi_label, text);
    } else {
        snprintf(text, sizeof(text), "%d", (int)lroundf(lo));
        set_label_text_if_changed(edge_lo_label, text);
        snprintf(text, sizeof(text), "%d", (int)lroundf(hi));
        set_label_text_if_changed(edge_hi_label, text);
    }
}
