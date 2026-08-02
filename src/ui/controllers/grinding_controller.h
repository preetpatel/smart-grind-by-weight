#pragma once
#include <lvgl.h>

class UIManager;
enum class UIState;
struct GrindEventData;

// Controls grind/pulse buttons, state transitions, chart updates, and auto-return timers

class GrindingUIController {
public:
    explicit GrindingUIController(UIManager* manager);

    void build_controls();
    void register_events();

    void on_state_changed(UIState new_state);
    void update(UIState current_state);

    void handle_grind_button();
    void handle_pulse_button();
    void handle_layout_toggle();
    void handle_purge_confirm_continue();

    void update_grind_button_icon();
    void update_button_layout();
    void update_grinding_targets();
    void reset_grind_complete_timer();

    void handle_grind_event(const GrindEventData& event_data);
    static void dispatch_event(const GrindEventData& event_data);

    // The last completed grind, for the ready screen's context block. Persisted
    // to NVS so it survives a power cut - a grinder that forgets the shot you
    // pulled ten minutes ago because it was unplugged is not much of a record.
    // The wall clock is stored alongside it when it is known; without a synced
    // clock the weight is still true but "2 h ago" would not be, so the screen
    // says only the weight.
    bool has_last_grind() const { return last_grind_weight_ > 0.0f; }
    float last_grind_weight() const { return last_grind_weight_; }
    bool last_grind_age_known() const { return last_grind_epoch_ != 0; }
    uint32_t last_grind_epoch() const { return last_grind_epoch_; }

    void load_last_grind();

private:
    // One of the two halves of the action bar, styled for its role.
    void style_action(lv_obj_t* button, lv_obj_t* label, const char* text, bool strong);
    void place_action(lv_obj_t* button, bool full_width, bool align_right, int32_t width);
    void enter_ready_state();
    void enter_edit_state();
    void enter_grinding_state();
    void enter_grind_complete_state();
    void enter_grind_timeout_state();
    void enter_menu_state();

    void start_grind_complete_timer();
    void start_grind_timeout_timer();
    void cancel_timers();

    static void grind_complete_timer_cb(lv_timer_t* timer);
    static void grind_timeout_timer_cb(lv_timer_t* timer);

    static GrindingUIController* instance_;

    UIManager* ui_manager_;
    lv_obj_t* grind_button_ = nullptr;
    lv_obj_t* grind_icon_ = nullptr;
    lv_obj_t* pulse_button_ = nullptr;
    lv_obj_t* pulse_icon_ = nullptr;
    lv_timer_t* grind_complete_timer_ = nullptr;
    lv_timer_t* grind_timeout_timer_ = nullptr;
    bool chart_updates_enabled_ = false;
    float final_grind_weight_ = 0.0f;
    int final_grind_progress_ = 0;
    float error_grind_weight_ = 0.0f;
    int error_grind_progress_ = 0;
    char error_message_[32] = {0};
    void store_last_grind(float weight);

    float last_grind_weight_ = 0.0f;
    uint32_t last_grind_epoch_ = 0;  // Unix seconds, 0 when the clock was never set
};
