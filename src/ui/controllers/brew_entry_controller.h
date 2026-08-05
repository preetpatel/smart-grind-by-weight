#pragma once
#include <lvgl.h>
#include <cstdint>
#include "../../system/bean_config.h"
#include "../../system/state_machine.h"
#include "../screens/brew_entry_screen.h"

class UIManager;

/**
 * BrewEntryController - drives the post-grind shot log.
 *
 * Lifecycle: GrindingUIController arms it on every COMPLETED event (a top-up
 * pulse re-arms with the updated dose), and when the completion screen exits
 * (OK press, cup removal, or the 60s watchdog all funnel through STOPPED),
 * begin_entry() consumes the pending shot and lands on BREW_ENTRY instead of
 * READY.
 *
 * Two steps: yield, then time. NEXT advances, DONE on the time step queues the
 * record and pulls a sync window forward. The X on the yield step discards the
 * whole thing; on the time step it saves the yield with the time left
 * unmeasured (0 on the wire, null in the store) rather than inventing one -
 * a fabricated time is indistinguishable from a real one downstream, and the
 * advice engine reads that column as evidence.
 *
 * The 15-minute timeout and a new grind starting both discard, whichever step
 * is showing.
 *
 * A prompt on screen is mirrored to NVS (BrewPromptStore), because a reset
 * mid-shot would otherwise take the shot with it - the grind is safely on
 * flash but the yield and time about to be typed in are not. restore_entry()
 * puts it back at boot.
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
    // Re-opens a prompt a reset interrupted. Called once at boot; returns
    // false (leaving the ready screen alone) when there is nothing to restore.
    bool restore_entry();

    // Jog hook (JogAdjustController) and click steps: one increment of
    // whichever field the current step is showing.
    void adjust(int direction);

    void on_state_changed(UIState new_state);

private:
    UIManager* ui_manager_;

    bool pending_ = false;
    uint32_t session_id_ = 0;
    uint32_t session_timestamp_ = 0;
    // The session whose prompt was already consumed, skipped or superseded -
    // repeated COMPLETED events for the same grind must not resurrect it.
    uint32_t settled_session_id_ = 0;
    float dose_g_ = 0.0f;

    BrewEntryScreen::Step step_ = BrewEntryScreen::Step::YIELD;
    float output_g_ = 0.0f;
    float yield_lo_ = 0.0f;
    float yield_hi_ = 0.0f;
    bool yield_stated_ = false;
    uint16_t time_s_ = 0;
    float time_lo_ = 0.0f;
    float time_hi_ = 0.0f;
    // True only while the prompt is actually on screen, so the boot-time
    // switch to READY doesn't wipe the record before it can be restored.
    bool presented_ = false;

    lv_timer_t* timeout_timer_ = nullptr;

    void advance();
    // timed: false records the shot with its time left unmeasured, which is
    // what skipping the time step means.
    void finish(bool save, bool timed);
    void refresh_screen();
    void cancel_timeout();
    static void timeout_cb(lv_timer_t* timer);

    // Resolves the bag's recipe for dose_g_ into the band members, returning
    // it so the caller can decide between its defaults and restored values.
    BeanConfig::Recipe resolve_recipe();
    // Puts the current step on screen and starts the 15-minute hold.
    void present();
    void persist();
};
