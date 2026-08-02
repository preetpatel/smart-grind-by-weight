#pragma once
#include <lvgl.h>
#include <cstdint>
#include "../../system/state_machine.h"

class UIManager;

/**
 * BrewEntryController - drives the post-grind shot log.
 *
 * Lifecycle: GrindingUIController arms it on every COMPLETED event (a top-up
 * pulse re-arms with the updated dose), and when the completion screen exits
 * (OK press, cup removal, or the 60s watchdog all funnel through STOPPED),
 * begin_entry() consumes the pending shot and lands on BREW_ENTRY instead of
 * READY. Done queues a brew record and pulls a sync window forward; the X,
 * the 15-minute timeout, or a new grind starting all discard it unrecorded.
 *
 * Eligibility is decided at arm time: an active bean must be configured and
 * the grind must have logged a session (cancelled grinds never reach
 * COMPLETED; logging-off grinds leave no session to attach a brew to).
 */
class BrewEntryController {
public:
    explicit BrewEntryController(UIManager* manager);

    void register_events();

    void arm(float dose_g);
    // A new grind supersedes an unanswered prompt.
    void discard_pending();
    bool begin_entry();

    // Jog hook (JogAdjustController) and click steps.
    void adjust_output(float delta_g);

    void on_state_changed(UIState new_state);

private:
    UIManager* ui_manager_;

    bool pending_ = false;
    uint32_t session_id_ = 0;
    uint32_t session_timestamp_ = 0;
    // The session whose prompt was already consumed, skipped or superseded -
    // repeated COMPLETED events for the same grind must not resurrect it.
    uint32_t settled_session_id_ = 0;
    float expected_g_ = 0.0f;
    float output_g_ = 0.0f;
    lv_timer_t* timeout_timer_ = nullptr;

    void finish(bool save);
    void refresh_screen();
    void cancel_timeout();
    static void timeout_cb(lv_timer_t* timer);
};
