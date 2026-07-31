#pragma once
#include <lvgl.h>

class UIManager;

// Shows Bluetooth connection status icon with color coding
// Shows diagnostic warning icon when issues detected
// Shows a WiFi icon only while the duty-cycled radio is actually up
// (connecting/syncing) - a brief blink per sync, not a persistent glyph

class StatusIndicatorController {
public:
    explicit StatusIndicatorController(UIManager* manager);

    void build();
    void update();

private:
    void update_ble_status_icon();
    void update_warning_icon();
    void update_wifi_status_icon();

    UIManager* ui_manager_;
    lv_obj_t* ble_status_icon_ = nullptr;
    lv_obj_t* warning_icon_ = nullptr;
    lv_obj_t* wifi_status_icon_ = nullptr;
};
