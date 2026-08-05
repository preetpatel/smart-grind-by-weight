#include "brew_prompt.h"

#include <Arduino.h>
#include <Preferences.h>
#include <cstring>

#include "../config/constants.h"

namespace {
constexpr const char* kNamespace = "brewprompt";
constexpr const char* kKey = "pending";
}  // namespace

namespace BrewPromptStore {

void save(const BrewPromptRecord& record) {
    BrewPromptRecord stored = record;
    stored.version = BREW_PROMPT_VERSION;
    stored.reserved = 0;

    Preferences prefs;
    if (!prefs.begin(kNamespace, false)) return;
    prefs.putBytes(kKey, &stored, sizeof(stored));
    prefs.end();
}

bool load(BrewPromptRecord* out) {
    if (!out) return false;

    Preferences prefs;
    if (!prefs.begin(kNamespace, true)) return false;

    BrewPromptRecord stored = {};
    size_t read = 0;
    if (prefs.getBytesLength(kKey) == sizeof(stored)) {
        read = prefs.getBytes(kKey, &stored, sizeof(stored));
    }
    prefs.end();

    // A record written by a firmware with a different layout has to be
    // ignored rather than reinterpreted - the fields would land on the wrong
    // members and pre-fill the screen with nonsense.
    if (read != sizeof(stored) || stored.version != BREW_PROMPT_VERSION) return false;
    if (stored.session_id == 0 || !(stored.dose_g > 0.0f)) return false;

    *out = stored;
    return true;
}

void clear() {
    Preferences prefs;
    if (!prefs.begin(kNamespace, false)) return;
    prefs.remove(kKey);
    prefs.end();
}

}  // namespace BrewPromptStore
