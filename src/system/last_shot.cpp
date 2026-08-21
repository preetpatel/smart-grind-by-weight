#include "last_shot.h"

#include <Arduino.h>
#include <Preferences.h>
#include <cmath>

#include "../config/constants.h"

LastShot last_shot;

void LastShot::init() {
    Preferences prefs;
    prefs.begin(kNvsNamespace, true);
    LastShotRecord stored = {};
    size_t read = prefs.getBytes(kKeyRecord, &stored, sizeof(stored));
    prefs.end();

    if (read == sizeof(stored) && stored.session_id != 0 && stored.dose_g > 0.0f) {
        record_ = stored;
        LOG_BLE("[SHOT] Last grind: %.1fg in, %.1fg out, %us\n", record_.dose_g,
                record_.yield_dg / 10.0f, (unsigned)record_.brew_time_s);
    }
}

void LastShot::persist() {
    Preferences prefs;
    prefs.begin(kNvsNamespace, false);
    prefs.putBytes(kKeyRecord, &record_, sizeof(record_));
    prefs.end();
}

void LastShot::record_dose(uint32_t session_id, float dose_g) {
    if (session_id == 0 || !(dose_g > 0.0f)) return;

    bool changed = session_id != record_.session_id
                   || fabsf(dose_g - record_.dose_g) >= 0.05f;
    record_.session_id = session_id;
    record_.dose_g = dose_g;
    // A new grind supersedes whatever shot the previous one logged.
    if (changed) {
        record_.brew_time_s = 0;
        record_.yield_dg = 0;
        persist();
    }
    dismissed_ = false;
}

void LastShot::record_brew(uint32_t session_id, float yield_g, uint16_t time_s) {
    if (!(yield_g > 0.0f)) return;  // a saved shot always carries a yield
    if (!last_shot_brew_applies(record_.session_id, session_id)) return;

    record_.yield_dg = (uint16_t)lroundf(yield_g * 10.0f);
    record_.brew_time_s = time_s;  // 0 travels as "unmeasured"
    persist();
    dismissed_ = false;
}
