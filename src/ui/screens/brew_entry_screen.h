#pragma once
#include <cstdint>
#include <lvgl.h>

/**
 * BrewEntryScreen - "how did the shot go?", shown after every logged grind
 * while an active bean is configured.
 *
 * Two steps over one layout (docs/mockups/brew-ui-revisions.html, set C):
 * yield in grams, then time in seconds. The anatomy is the edit screen's - a
 * big value up top, a full-width jog row, a commit row at the bottom - so
 * there is nothing new to learn, and the value gets the whole 264px rather
 * than the ~148px that edge-mounted jog buttons left it (six characters at
 * montserrat_48 measure up to 166px, so that gap really did overflow).
 *
 * Nothing is placed in the top-right 90x48: the status icon row owns it, and
 * that is what the old corner X collided with.
 *
 * The track under the value shows the band the recipe aims at. Where the bag
 * states no band it is hidden rather than drawn around an invented tolerance.
 */
class BrewEntryScreen {
public:
    enum class Step : uint8_t { YIELD, TIME };

    void create();
    void show();
    void hide();
    bool is_visible() const { return visible; }

    void set_bean_name(const char* name);
    void set_step(Step step);

    // value: what the user has dialled in. lo/hi: the band it is judged
    // against; pass hi <= lo for "no band stated" and the track hides entirely.
    // hint: replaces the track's numeric edge labels - used where the band is
    // a derived tolerance ("1 : 1.5 +/- 3 %") rather than numbers off a bag,
    // and to say so outright where there is no band at all.
    void set_value(Step step, float value, float lo, float hi, const char* hint = nullptr);

    lv_obj_t* get_minus_button() { return minus_btn; }
    lv_obj_t* get_plus_button() { return plus_btn; }
    lv_obj_t* get_done_button() { return done_btn; }
    lv_obj_t* get_skip_button() { return skip_btn; }

private:
    lv_obj_t* screen = nullptr;
    lv_obj_t* name_label = nullptr;
    lv_obj_t* value_label = nullptr;
    lv_obj_t* track = nullptr;
    lv_obj_t* track_band = nullptr;
    lv_obj_t* track_marker = nullptr;
    lv_obj_t* edge_lo_label = nullptr;
    lv_obj_t* edge_hi_label = nullptr;
    lv_obj_t* hint_label = nullptr;
    lv_obj_t* step_dots[2] = {nullptr, nullptr};
    lv_obj_t* minus_btn = nullptr;
    lv_obj_t* plus_btn = nullptr;
    lv_obj_t* done_btn = nullptr;
    lv_obj_t* done_label = nullptr;
    lv_obj_t* skip_btn = nullptr;
    bool visible = false;

    void set_track_visible(bool shown);
    void set_edges_visible(bool shown);
};
