#pragma once
#include <lvgl.h>
#include "../../config/constants.h"
#include "grinding_screen_base.h"

/*
 * The default grinding view: a ring that fills, the live weight inside it, and
 * one phrase underneath saying what it is aiming at - replaced by the verdict
 * once the grind lands. The ring is the only coloured element on the screen,
 * which is what makes it readable from across the room.
 */
class GrindingScreenArc : public IGrindingScreen {
private:
    lv_obj_t* screen = nullptr;
    lv_obj_t* profile_label = nullptr;
    lv_obj_t* target_label = nullptr;   // Target while running, verdict when complete
    lv_obj_t* weight_label = nullptr;
    lv_obj_t* unit_label = nullptr;     // Split out so it can sit on the hero's baseline
    lv_obj_t* progress_arc = nullptr;
    bool visible = false;
    bool time_mode = false;

public:
    void create() override;
    void show() override;
    void hide() override;
    void update_profile_name(const char* name) override;
    void update_target_weight(float weight) override;
    void update_target_weight_text(const char* text) override;
    void update_target_time(float seconds);
    void update_current_weight(float weight) override;
    void update_tare_display() override;
    void update_progress(int percent) override;
    void set_result_tone(ResultTone tone) override;
    void set_time_mode(bool enabled);

    bool is_visible() const override { return visible; }
    lv_obj_t* get_screen() const override { return screen; }
};
