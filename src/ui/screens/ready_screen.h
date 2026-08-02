#pragma once
#include <lvgl.h>
#include "../../config/constants.h"
#include "../../controllers/grind_mode.h"

/*
 * The screen the grinder wears 99% of the time.
 *
 * Layout, top to bottom: the profile name as a kicker, the dose as the hero,
 * three dots standing in for the profiles, and - only when there is something
 * true to say - a hairline with up to two context phrases under it.
 *
 * The phrases are phrases, not label/value rows. On 21.8 mm of glass a label
 * column costs half the width, and splitting a sentence across two columns
 * reads as broken English because the eye takes the left column as a category.
 * Anything that cannot be said as one short phrase does not belong here.
 *
 * The tabview underneath is unchanged: three profiles plus the menu page, swiped
 * horizontally with the tab bar hidden. Only the pages were redrawn.
 */
class ReadyScreen {
public:
    void create();
    void show();
    void hide();

    void update_profile_values(const float values[3], GrindMode mode);
    void update_clock();  // Shows the wall clock once it has synced over BLE or WiFi
    void set_active_tab(int tab);
    // Moves the dots and the context block to match a tab the user swiped to,
    // without driving the tabview back (which would fight its own animation).
    void sync_indicator(int tab);
    void set_profile_long_press_handler(lv_event_cb_t handler);

    // The context block. Pass nullptr or "" for a line to drop it; pass nothing
    // for either and the hairline goes too, leaving the pure dose screen.
    void set_context(const char* first, const char* second);

    // Raised over the whole screen when the grinder cannot honour what the
    // screen would otherwise offer. Pass nullptr or "" to clear it.
    void set_warning(const char* title, const char* phrase);
    bool is_warning_active() const { return warning_active; }

    bool is_visible() const { return visible; }
    lv_obj_t* get_screen() const { return screen; }
    lv_obj_t* get_tabview() const { return tabview; }
    lv_obj_t* get_menu_tab() const { return menu_tab; }
    lv_obj_t* get_menu_button() const { return menu_button; }

private:
    void create_profile_page(lv_obj_t* parent, int profile_index, const char* profile_name);
    void sync_dots(int active_index);

    lv_obj_t* screen = nullptr;
    lv_obj_t* tabview = nullptr;
    lv_obj_t* profile_tabs[4] = {nullptr, nullptr, nullptr, nullptr};
    lv_obj_t* menu_tab = nullptr;

    lv_obj_t* kicker_labels[3] = {nullptr, nullptr, nullptr};
    lv_obj_t* weight_labels[3] = {nullptr, nullptr, nullptr};
    lv_obj_t* unit_labels[3] = {nullptr, nullptr, nullptr};
    lv_obj_t* dots[3][3] = {};  // [page][dot]

    // The context block lives on the screen rather than inside a tab page, so it
    // stays put while the pages swipe underneath it.
    lv_obj_t* context_box = nullptr;
    lv_obj_t* context_rule = nullptr;
    lv_obj_t* context_labels[UI_CONTEXT_MAX_PHRASES] = {nullptr, nullptr};

    lv_obj_t* menu_button = nullptr;   // Top-centre affordance; the menu is not a profile
    lv_obj_t* warning_box = nullptr;
    lv_obj_t* warning_title = nullptr;
    lv_obj_t* warning_phrase = nullptr;
    bool warning_active = false;

    lv_obj_t* clock_label = nullptr;
    char clock_text[12] = {0};  // "12:34 PM" plus slack

    bool visible = false;
};
