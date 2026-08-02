#pragma once

#include <cstdint>

class UIManager;

/*
 * Owns the single "nobody is here" decision and drives the screensaver from it.
 *
 * Idle is measured from the last touch or the last weight movement, whichever is
 * more recent. Two stages follow:
 *   1. USER_SCREEN_AUTO_DIM_TIMEOUT_MS - the clock face takes over the screen.
 *   2. + USER_IDLE_CLOCK_DIM_DELAY_MS  - the backlight drops to screensaver level.
 * When the face cannot be shown (switched off, clock never synced, or a state
 * that must stay visible) stage 1 is skipped and the screen dims at the original
 * mark, which is the behaviour that predates the clock face.
 */
class ScreenTimeoutController {
public:
    explicit ScreenTimeoutController(UIManager* manager);

    void register_events();
    void update();

    // Returns the screen to its awake state. Called on every UI state change so a
    // screen raised from outside the touch loop - an incoming OTA, a data export -
    // is never left stranded behind the clock face.
    void wake();

private:
    bool clock_face_allowed() const;
    uint32_t idle_duration_ms(uint32_t now_ms);
    void set_clock_face_visible(bool visible);
    void set_dimmed(bool dimmed);

    UIManager* ui_manager_;
    uint32_t last_weight_activity_ms_;
    bool screen_dimmed_;
    bool clock_face_visible_;
};
