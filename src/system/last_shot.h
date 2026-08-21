#pragma once

#include <stdint.h>
#include <stddef.h>
#include <stdio.h>

/**
 * LastShot - what the last completed grind delivered, for the ready-screen
 * chip.
 *
 * The chip used to carry the server's finer/coarser verdict; it now shows the
 * raw evidence instead - the dose that landed and, when the shot log was
 * answered, how long the shot took - so the user can judge the next
 * adjustment themselves. The verdict stays server-side (dashboard advice).
 *
 * Written at two moments, both on the main-loop task: the dose when a grind
 * completes (re-written by each top-up pulse, which re-enters COMPLETED with
 * the updated weight), and the shot time when the brew entry prompt is
 * answered. Single-task access, so unlike BeanConfig there is no reload flag.
 *
 * One NVS blob survives reboot: "what did I do last time" is exactly the
 * question a grinder switched off after dialing in needs to answer.
 */
struct LastShotRecord {
    uint32_t session_id;
    float dose_g;
    // 0 = unmeasured (prompt skipped or never shown).
    uint16_t brew_time_s;
    uint16_t reserved;
};

#define LAST_SHOT_VERSION 1

/**
 * Chip text for the record: "LAST 18.2G · 28S", or "LAST 18.2G" when the
 * shot time was never measured.
 */
inline void last_shot_format_text(char* out, size_t len,
                                  float dose_g, uint16_t brew_time_s) {
    if (!out || len == 0) return;
    // "\xc2\xb7" is U+00B7 MIDDLE DOT, present in the built-in montserrat
    // fonts (0x20-0x7F, 0xB0, 0xB7, 0x2022).
    if (brew_time_s > 0) {
        snprintf(out, len, "LAST %.1fG \xc2\xb7 %uS", dose_g, (unsigned)brew_time_s);
    } else {
        snprintf(out, len, "LAST %.1fG", dose_g);
    }
}

/**
 * Whether an answered shot log belongs to the grind the stored record
 * describes. A prompt superseded by a newer grind must not stamp its time
 * onto the newer grind's record.
 */
inline bool last_shot_brew_time_applies(uint32_t stored_session_id,
                                        uint32_t finishing_session_id) {
    return stored_session_id != 0 && stored_session_id == finishing_session_id;
}

class LastShot {
public:
    void init();

    // Called on grind completion (including top-up pulse re-entries). A
    // session_id of 0 means logging was off - nothing to attach a shot to.
    void record_dose(uint32_t session_id, float dose_g);
    // Called when the brew entry prompt records a measured time.
    void record_brew_time(uint32_t session_id, uint16_t time_s);

    bool is_valid() const { return record_.session_id != 0; }
    float get_dose_g() const { return record_.dose_g; }
    uint16_t get_brew_time_s() const { return record_.brew_time_s; }

    // Tap-to-dismiss on the chip; the next recorded dose or time brings it
    // back. RAM-only, like BeanConfig's dismissal flags.
    void dismiss() { dismissed_ = true; }
    bool is_dismissed() const { return dismissed_; }

private:
    static constexpr const char* kNvsNamespace = "lastshot";
    static constexpr const char* kKeyRecord = "rec";

    void persist();

    LastShotRecord record_ = {};
    bool dismissed_ = false;
};

extern LastShot last_shot;
