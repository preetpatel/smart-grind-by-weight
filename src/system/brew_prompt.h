#pragma once

#include <stdint.h>

/**
 * BrewPrompt - the unanswered shot log, kept across a reset.
 *
 * The brew entry screen holds for 15 minutes while the shot is pulled, which
 * is exactly the window a mid-shot reset lands in: the grind is already on
 * flash, but the yield and time that were about to be typed in are gone, and
 * the user is holding a portafilter with no way back to the prompt.
 *
 * So the prompt is written to NVS the moment it goes on screen and again when
 * it advances a step - two small writes per shot, not one per jog tick - and
 * cleared through a single choke point when the screen is left for any reason
 * (recorded, skipped, timed out, or superseded by a new grind).
 *
 * Deliberately separate from BrewLog: that is the queue of *answered* shots
 * awaiting upload, and every file under /brews is treated as one.
 */
struct BrewPromptRecord {
    uint16_t version;
    uint16_t step;  // BrewEntryScreen::Step
    uint32_t session_id;
    uint32_t session_timestamp;
    float dose_g;
    // Wall clock when the prompt opened, 0 when the clock was never synced.
    uint32_t opened_epoch;
    float output_g;
    uint16_t time_s;
    uint16_t reserved;
};

#define BREW_PROMPT_VERSION 1

/**
 * Whether a stored prompt should go back on screen after a reset.
 *
 * A crash or brownout mid-shot is what this exists for, so a record is
 * restored by default. Two things retire one instead:
 *
 *  - A clean power-on. The grinder was switched off and come back to, and a
 *    prompt from whenever that was is clutter in front of the ready screen,
 *    not a rescue. (A brownout deep enough to read as a power-on loses the
 *    shot too - the honest trade for never resurrecting a stale prompt.)
 *  - A record already older than the window the live screen would have
 *    honoured.
 *
 * An unsynced clock cannot age anything, and boot reaches this point before
 * SNTP does, so the age test only applies where the clock can actually answer.
 * Restoring is the safe side of that: the on-screen timeout still expires it.
 */
inline bool brew_prompt_should_restore(bool have_record,
                                       bool power_on_reset,
                                       bool clock_synced,
                                       uint32_t opened_epoch,
                                       uint32_t now_epoch,
                                       uint32_t window_s) {
    if (!have_record) return false;
    if (power_on_reset) return false;

    bool can_age = clock_synced && opened_epoch > 0 && now_epoch >= opened_epoch;
    if (can_age) return (now_epoch - opened_epoch) <= window_s;

    return true;
}

namespace BrewPromptStore {

// One blob in the "brewprompt" NVS namespace. save() overwrites, so a step
// advance costs the same as the first write.
void save(const BrewPromptRecord& record);
bool load(BrewPromptRecord* out);
void clear();

}  // namespace BrewPromptStore
