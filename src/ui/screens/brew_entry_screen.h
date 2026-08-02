#pragma once
#include <lvgl.h>

/**
 * BrewEntryScreen - "how did the shot go?", shown after every logged grind
 * while an active bean is configured.
 *
 * Delta layout (mockups/brew-feature-mockups.html, B): the big number is the
 * shot yield, pre-set to dose x ratio; the line under it answers "how far
 * off?" in colour (orange = ran fast, blue = ran slow, green = on target).
 * Jog buttons sit at the screen edges where thumbs land; one full-width DONE;
 * the X in the corner skips.
 */
class BrewEntryScreen {
public:
    void create();
    void show();
    void hide();
    bool is_visible() const { return visible; }

    void set_bean_name(const char* name);
    // Updates the yield readout and the coloured deviation line.
    void set_values(float output_g, float expected_g);

    lv_obj_t* get_minus_button() { return minus_btn; }
    lv_obj_t* get_plus_button() { return plus_btn; }
    lv_obj_t* get_done_button() { return done_btn; }
    lv_obj_t* get_skip_button() { return skip_btn; }

private:
    lv_obj_t* screen = nullptr;
    lv_obj_t* name_label = nullptr;
    lv_obj_t* skip_btn = nullptr;
    lv_obj_t* expected_label = nullptr;
    lv_obj_t* minus_btn = nullptr;
    lv_obj_t* plus_btn = nullptr;
    lv_obj_t* output_label = nullptr;
    lv_obj_t* delta_label = nullptr;
    lv_obj_t* done_btn = nullptr;
    bool visible = false;
};
