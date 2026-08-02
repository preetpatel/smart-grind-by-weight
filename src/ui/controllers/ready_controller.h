#pragma once
#include <lvgl.h>
#include "../event_bridge_lvgl.h"

class UIManager;

// Handles profile tab navigation, long-press editing, and swipe mode switching

class ReadyUIController {
public:
    explicit ReadyUIController(UIManager* manager);

    void register_events();
    void update();
    void refresh_profiles();

    // Recomputes the ready screen's two context phrases from live state. Cheap
    // and idempotent: it writes nothing when the wording has not changed, and
    // hides the block entirely when neither line has anything true to say.
    void update_context();
    void handle_tab_change(int tab);
    void handle_profile_long_press();
    void toggle_mode();

private:
    // Raises or clears the warning takeover. True when it took the screen.
    bool update_warning();

    UIManager* ui_manager_;
};
