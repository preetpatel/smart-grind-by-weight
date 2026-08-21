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
        LOG_BLE("[SHOT] Last grind: %.1fg%s%us\n", record_.dose_g,
                record_.brew_time_s ? " over " : "", (unsigned)record_.brew_time_s);
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
    // A new grind supersedes whatever time the previous shot logged.
    if (changed) {
        record_.brew_time_s = 0;
        persist();
    }
    dismissed_ = false;
}

void LastShot::record_brew_time(uint32_t session_id, uint16_t time_s) {
    if (time_s == 0) return;  // 0 travels as "unmeasured"
    if (!last_shot_brew_time_applies(record_.session_id, session_id)) return;

    record_.brew_time_s = time_s;
    persist();
    dismissed_ = false;
}
