#pragma once
#include <lvgl.h>
#include "../../config/constants.h"
#include "../../controllers/grind_mode.h"

class ReadyScreen {
private:
    lv_obj_t* screen;
    lv_obj_t* tabview;
    lv_obj_t* profile_tabs[4];
    lv_obj_t* weight_labels[3];
    lv_obj_t* menu_tab;
    lv_obj_t* clock_label;
    lv_obj_t* advice_chip;
    lv_obj_t* advice_label;
    char clock_text[12];  // "12:34 PM" plus slack
    bool visible;

public:
    void create();
    void show();
    void hide();
    void update_profile_values(const float values[3], GrindMode mode);
    void update_clock();  // Shows the wall clock once it has synced over BLE or WiFi
    void update_advice_chip();  // Server-computed finer/coarser verdict; tap dismisses
    void set_active_tab(int tab);
    void set_profile_long_press_handler(lv_event_cb_t handler);
    
    bool is_visible() const { return visible; }
    lv_obj_t* get_screen() const { return screen; }
    lv_obj_t* get_tabview() const { return tabview; }
    lv_obj_t* get_menu_tab() const { return menu_tab; }
    
private:
    void create_profile_page(lv_obj_t* parent, int profile_index, const char* profile_name, float weight);
    void create_menu_page(lv_obj_t* parent);
};
