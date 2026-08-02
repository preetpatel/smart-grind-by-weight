#pragma once
#include <lvgl.h>
#include <cstdint>

/*
 * The clock face the grinder wears once it has been left alone.
 *
 * Deliberately not a UIState: it is a full-screen object created on lv_scr_act()
 * after every other screen, so it simply covers whatever is underneath - the
 * state machine, the auto-start-on-cup watcher and the status icons all keep
 * running unchanged, and waking up is nothing more than hiding this object.
 *
 * The whole face lives in one container so it can be shifted a few pixels every
 * minute. The panel is AMOLED and this view can sit lit for hours between
 * grinds, which is exactly the recipe for burn-in.
 */
class IdleScreen {
public:
    void create();
    void show();
    void hide();

    // Refreshes the time and advances the pixel-shift. Cheap when nothing changed:
    // both the labels and the alignment are only written on an actual change.
    void update(uint32_t now_ms);

    bool is_visible() const { return visible; }

private:
    void update_time();
    void update_shift(uint32_t now_ms);

    lv_obj_t* screen = nullptr;
    lv_obj_t* content = nullptr;         // Shifted as one unit; the bean readout will join it here
    lv_obj_t* time_label = nullptr;
    lv_obj_t* meridiem_label = nullptr;  // Empty and hidden on a 24-hour clock
    int shift_index = -1;
    bool visible = false;
};
