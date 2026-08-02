#include "status_indicator_controller.h"

#include "../../config/constants.h"
#include "../../system/diagnostics_controller.h"
#include "../../system/wifi_service.h"
#include "../ui_helpers.h"
#include "../ui_icons.h"
#include "../ui_manager.h"

namespace {
    constexpr lv_coord_t kStatusRowMarginRight = 10;  // Matches the ready screen clock inset
    constexpr lv_coord_t kStatusRowMarginTop = 10;
    constexpr lv_coord_t kStatusIconGap = 8;          // Snug enough to read as one cluster
}

StatusIndicatorController::StatusIndicatorController(UIManager* manager)
    : ui_manager_(manager) {}

lv_obj_t* StatusIndicatorController::create_status_row() {
    lv_obj_t* row = lv_obj_create(lv_scr_act());
    lv_obj_set_size(row, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
    lv_obj_align(row, LV_ALIGN_TOP_RIGHT, -kStatusRowMarginRight, kStatusRowMarginTop);
    lv_obj_set_style_bg_opa(row, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(row, 0, 0);
    lv_obj_set_style_pad_all(row, 0, 0);
    lv_obj_set_style_pad_gap(row, kStatusIconGap, 0);
    lv_obj_set_layout(row, LV_LAYOUT_FLEX);
    lv_obj_set_flex_flow(row, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(row, LV_FLEX_ALIGN_END, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_clear_flag(row, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_clear_flag(row, LV_OBJ_FLAG_CLICKABLE);
    return row;
}

lv_obj_t* StatusIndicatorController::create_status_icon(IconKind kind, uint32_t color) {
    lv_obj_t* icon = nullptr;
    switch (kind) {
        case IconKind::WIFI:
            icon = ui_icon_wifi(status_row_, color);
            break;
        case IconKind::WARNING:
            icon = ui_icon_warning(status_row_, color);
            break;
        case IconKind::BLUETOOTH:
            icon = ui_icon_bluetooth(status_row_, color);
            break;
    }
    if (icon) {
        lv_obj_add_flag(icon, LV_OBJ_FLAG_HIDDEN);
        lv_obj_clear_flag(icon, LV_OBJ_FLAG_CLICKABLE);
    }
    return icon;
}

void StatusIndicatorController::build() {
    if (!ui_manager_) {
        return;
    }

    if (ble_status_icon_) {
        return;
    }

    status_row_ = create_status_row();

    // Laid out left to right in creation order: WiFi, warning, BLE. The WiFi
    // icon only shows for the few seconds per day the radio is actually up.
    wifi_status_icon_ = create_status_icon(IconKind::WIFI, UI_COLOR_DIM);
    warning_icon_ = create_status_icon(IconKind::WARNING, UI_COLOR_WARN);
    ble_status_icon_ = create_status_icon(IconKind::BLUETOOTH, UI_COLOR_DIM);

    update_ble_status_icon();
    update_warning_icon();
    update_wifi_status_icon();
}

void StatusIndicatorController::update() {
    update_ble_status_icon();
    update_warning_icon();
    update_wifi_status_icon();
}

void StatusIndicatorController::update_ble_status_icon() {
    if (!ui_manager_ || !ble_status_icon_) {
        return;
    }

    auto* bluetooth = ui_manager_->bluetooth_manager;
    if (bluetooth && bluetooth->is_enabled()) {
        lv_obj_clear_flag(ble_status_icon_, LV_OBJ_FLAG_HIDDEN);
        // This runs every UI frame in every state, so only touch the style when the colour
        // actually changes - lv_obj_set_style_text_color() always invalidates the object.
        ui_icon_set_color(ble_status_icon_, bluetooth->is_connected() ? UI_COLOR_OK : UI_COLOR_DIM);
    } else {
        lv_obj_add_flag(ble_status_icon_, LV_OBJ_FLAG_HIDDEN);
    }
}

void StatusIndicatorController::update_wifi_status_icon() {
    if (!wifi_status_icon_) {
        return;
    }

    // Mirrors the BLE icon's colour language: accent while associating,
    // green once on the network pulling time. Hidden whenever the radio is
    // off, which is almost always - the icon is sync feedback, not a
    // "WiFi is set up" badge (that lives in Menu -> WiFi).
    switch (wifi_service.get_state()) {
        case WifiService::State::CONNECTING:
            lv_obj_clear_flag(wifi_status_icon_, LV_OBJ_FLAG_HIDDEN);
            ui_icon_set_color(wifi_status_icon_, UI_COLOR_DIM);
            break;
        case WifiService::State::SYNCING:
            lv_obj_clear_flag(wifi_status_icon_, LV_OBJ_FLAG_HIDDEN);
            ui_icon_set_color(wifi_status_icon_, UI_COLOR_OK);
            break;
        default:
            lv_obj_add_flag(wifi_status_icon_, LV_OBJ_FLAG_HIDDEN);
            break;
    }
}

void StatusIndicatorController::update_warning_icon() {
    if (!ui_manager_ || !warning_icon_) {
        return;
    }

    // Check if there are any diagnostic warnings
    if (ui_manager_->diagnostics_controller_) {
        DiagnosticCode diagnostic = ui_manager_->diagnostics_controller_->get_highest_priority_warning();
        if (diagnostic != DiagnosticCode::NONE) {
            lv_obj_clear_flag(warning_icon_, LV_OBJ_FLAG_HIDDEN);
        } else {
            lv_obj_add_flag(warning_icon_, LV_OBJ_FLAG_HIDDEN);
        }
    } else {
        lv_obj_add_flag(warning_icon_, LV_OBJ_FLAG_HIDDEN);
    }
}
