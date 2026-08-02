#include "blocking_overlay.h"
#include "../../config/constants.h"
#include <lvgl.h>
#include <Arduino.h>

// Static instance
BlockingOperationOverlay* BlockingOperationOverlay::g_instance = nullptr;

void BlockingOperationOverlay::init() {
    // Create overlay (initially hidden)
    overlay = lv_obj_create(lv_scr_act());
    lv_obj_set_size(overlay, LV_PCT(100), LV_PCT(100));
    lv_obj_set_style_bg_color(overlay, lv_color_hex(UI_COLOR_BG), 0);
    lv_obj_set_style_bg_opa(overlay, THEME_OPACITY_OVERLAY, 0);
    lv_obj_set_style_border_width(overlay, 0, 0);
    lv_obj_set_style_pad_all(overlay, 0, 0);
    lv_obj_center(overlay);
    
    // Ensure overlay is always on top by moving to foreground
    lv_obj_move_foreground(overlay);

    lv_obj_t* content = lv_obj_create(overlay);
    lv_obj_set_style_bg_opa(content, LV_OPA_TRANSP, 0);
    lv_obj_set_size(content, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
    lv_obj_set_style_border_width(content, 0, 0);
    lv_obj_set_style_pad_all(content, 0, 0);
    lv_obj_set_style_pad_gap(content, 5, 0);
    lv_obj_center(content);

    lv_obj_set_layout(content, LV_LAYOUT_FLEX);
    lv_obj_set_flex_flow(content, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(content, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    
    // Create main label
    label = lv_label_create(content);
    lv_obj_set_style_text_font(label, &lv_font_montserrat_32, 0);
    lv_obj_set_style_text_color(label, lv_color_hex(UI_COLOR_INK), 0);
    lv_obj_set_style_text_align(label, LV_TEXT_ALIGN_CENTER, 0);

    wait_label = lv_label_create(content);
    lv_label_set_text(wait_label, "Please Wait...");
    lv_obj_set_style_text_font(wait_label, &lv_font_montserrat_24, 0);
    lv_obj_set_style_text_color(wait_label, lv_color_hex(UI_COLOR_DIM), 0);
    lv_obj_set_style_text_align(wait_label, LV_TEXT_ALIGN_CENTER, 0);

    // Hide initially
    lv_obj_add_flag(overlay, LV_OBJ_FLAG_HIDDEN);
    is_visible = false;
    operation_timer = nullptr;
    message_timer = nullptr;
}

// Restores the in-progress presentation, undoing anything show_message() changed.
void BlockingOperationOverlay::apply_blocking_style() {
    lv_obj_set_style_text_font(label, &lv_font_montserrat_32, 0);
    lv_obj_set_style_text_color(label, lv_color_hex(UI_COLOR_INK), 0);
    lv_obj_clear_flag(wait_label, LV_OBJ_FLAG_HIDDEN);
}

void BlockingOperationOverlay::show_and_execute(BlockingOperation op_type, 
                                                OperationCallback operation_func,
                                                OperationCallback completion_func,
                                                const char* custom_message) {
    
    // A message left over from show_message() must not style this operation
    cancel_pending_message();
    apply_blocking_style();

    // Set appropriate message
    const char* message = get_operation_message(op_type, custom_message);
    lv_label_set_text(label, message);
    lv_label_set_long_mode(label, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(label, 240);

    // Store callbacks
    completion_callback = completion_func;
    operation_callback = operation_func;
    
    // Show overlay
    lv_obj_clear_flag(overlay, LV_OBJ_FLAG_HIDDEN);
    
    // Ensure overlay is on top when shown
    lv_obj_move_foreground(overlay);
    
    is_visible = true;
    
    // Start operation after small delay to ensure overlay is visible
    if (operation_timer) {
        lv_timer_del(operation_timer);
    }
    
    operation_timer = lv_timer_create(operation_timer_cb, 100, nullptr);
    lv_timer_set_repeat_count(operation_timer, 1);
}

void BlockingOperationOverlay::hide_and_complete() {
    // Hide overlay
    lv_obj_add_flag(overlay, LV_OBJ_FLAG_HIDDEN);
    is_visible = false;
    
    // Clean up timer
    if (operation_timer) {
        lv_timer_del(operation_timer);
        operation_timer = nullptr;
    }
    
    // Call completion callback if provided
    if (completion_callback) {
        completion_callback();
        completion_callback = nullptr;
    }
    
    // Clear operation callback
    operation_callback = nullptr;
}

const char* BlockingOperationOverlay::get_operation_message(BlockingOperation op_type, const char* custom_message) {
    if (custom_message) {
        return custom_message;
    }
    
    switch (op_type) {
        case BlockingOperation::TARING:
            return "TARING";
        case BlockingOperation::CALIBRATING:
            return "CALIBRATING";
        case BlockingOperation::SETTLING:
            return "SETTLING";
        case BlockingOperation::BLE_ENABLING:
            return "ENABLING BLUETOOTH";
        case BlockingOperation::LOADING_STATISTICS:
            return "LOADING STATISTICS";
        default:
            return "PROCESSING";
    }
}

void BlockingOperationOverlay::operation_timer_cb(lv_timer_t* timer) {
    auto* instance = &getInstance();
    
    // Execute the blocking operation
    if (instance->operation_callback) {
        instance->operation_callback();
    }
    
    // Hide overlay and call completion callback
    instance->hide_and_complete();
}

void BlockingOperationOverlay::show(const char* message) {
    // Cancel any operation still pending from a previous show_and_execute(), otherwise it
    // would fire against a message-only overlay and invoke a stale callback.
    cancel_pending_operation();
    cancel_pending_message();
    apply_blocking_style();

    // Set message
    lv_label_set_text(label, message);

    // Show overlay
    lv_obj_clear_flag(overlay, LV_OBJ_FLAG_HIDDEN);
    lv_obj_move_foreground(overlay);
    is_visible = true;
}

void BlockingOperationOverlay::show_message(const char* text, uint32_t duration_ms) {
    // Deliberately not cancel_pending_operation(): this is normally called from a completion
    // callback, and clearing completion_callback would destroy the std::function currently
    // executing. Dropping the timer is enough to stop a queued operation overwriting us.
    cancel_operation_timer();
    cancel_pending_message();

    lv_obj_add_flag(wait_label, LV_OBJ_FLAG_HIDDEN);
    lv_obj_set_style_text_font(label, &lv_font_montserrat_24, 0);
    lv_obj_set_style_text_color(label, lv_color_hex(UI_COLOR_BAD), 0);
    lv_label_set_text(label, text);
    lv_label_set_long_mode(label, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(label, 240);

    lv_obj_clear_flag(overlay, LV_OBJ_FLAG_HIDDEN);
    lv_obj_move_foreground(overlay);
    is_visible = true;

    message_timer = lv_timer_create(message_timer_cb, duration_ms, nullptr);
    lv_timer_set_repeat_count(message_timer, 1);
}

void BlockingOperationOverlay::hide() {
    cancel_pending_operation();
    cancel_pending_message();
    apply_blocking_style();

    // Hide overlay
    lv_obj_add_flag(overlay, LV_OBJ_FLAG_HIDDEN);
    is_visible = false;
}

void BlockingOperationOverlay::message_timer_cb(lv_timer_t* timer) {
    auto& instance = getInstance();
    // LVGL retires this one-shot timer itself once the callback returns; forget it first so
    // hide() does not try to delete a timer that is still running.
    instance.message_timer = nullptr;
    instance.hide();
}

void BlockingOperationOverlay::cancel_operation_timer() {
    if (operation_timer) {
        lv_timer_del(operation_timer);
        operation_timer = nullptr;
    }
}

void BlockingOperationOverlay::cancel_pending_operation() {
    cancel_operation_timer();
    operation_callback = nullptr;
    completion_callback = nullptr;
}

void BlockingOperationOverlay::cancel_pending_message() {
    if (message_timer) {
        lv_timer_del(message_timer);
        message_timer = nullptr;
    }
}
