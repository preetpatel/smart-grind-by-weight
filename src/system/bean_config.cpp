#include "bean_config.h"
#include <Arduino.h>
#include <Preferences.h>
#include <cstring>

BeanConfig bean_config;

namespace {
    constexpr const char* kNvsNamespace = "bean";
    constexpr const char* kKeyName = "name";
    constexpr const char* kKeyRatio = "ratio";
    constexpr const char* kKeyBrewSec = "brewsec";
    constexpr const char* kKeySet = "set";
}

void BeanConfig::init() {
    reload_config();
    if (configured) {
        LOG_BLE("[BEAN] Active bean: %s (1:%.2f over %us)\n", name, ratio, brew_time_s);
    }
}

void BeanConfig::reload_config() {
    Preferences prefs;
    prefs.begin(kNvsNamespace, true);
    String stored_name = prefs.getString(kKeyName, "");
    float stored_ratio = prefs.getFloat(kKeyRatio, 0.0f);
    uint16_t stored_time = (uint16_t)prefs.getUShort(kKeyBrewSec, 30);
    bool stored_set = prefs.getBool(kKeySet, false);
    prefs.end();

    strncpy(name, stored_name.c_str(), sizeof(name) - 1);
    name[sizeof(name) - 1] = '\0';
    ratio = stored_ratio;
    brew_time_s = stored_time;
    configured = stored_set && name[0] != '\0' && stored_ratio > 0.0f;
    config_dirty = false;
}

void BeanConfig::reload_if_dirty() {
    if (config_dirty) reload_config();
}

void BeanConfig::set_config(const char* new_name, float new_ratio, uint16_t new_brew_time_s) {
    if (!new_name || !new_name[0] || !(new_ratio > 0.0f)) return;
    Preferences prefs;
    prefs.begin(kNvsNamespace, false);
    prefs.putString(kKeyName, new_name);
    prefs.putFloat(kKeyRatio, new_ratio);
    prefs.putUShort(kKeyBrewSec, new_brew_time_s > 0 ? new_brew_time_s : 30);
    prefs.putBool(kKeySet, true);
    prefs.end();

    config_dirty = true;
    LOG_BLE("[BEAN] Active bean set: %s (1:%.2f over %us)\n",
            new_name, new_ratio, (unsigned)new_brew_time_s);
}

void BeanConfig::clear_config() {
    Preferences prefs;
    prefs.begin(kNvsNamespace, false);
    prefs.clear();
    prefs.end();

    config_dirty = true;
    // No bean means no evidence to advise from, and no bag to run out of.
    advice = Advice::NONE;
    shots_remaining = -1;
    bag_low = false;
    LOG_BLE("[BEAN] Active bean cleared\n");
}

void BeanConfig::set_advice(Advice new_advice) {
    if (new_advice != advice) advice_dismissed = false;
    advice = new_advice;
}

void BeanConfig::set_bag_status(int16_t new_shots_remaining, bool new_low) {
    // A dismissed warning comes back when the count moves - the bag got
    // emptier, which is new information.
    if (new_shots_remaining != shots_remaining) bag_dismissed = false;
    shots_remaining = new_shots_remaining;
    bag_low = new_low;
}

const char* BeanConfig::advice_name() const {
    switch (advice) {
        case Advice::NONE: return "none";
        case Advice::OK: return "ok";
        case Advice::FINER: return "finer";
        case Advice::COARSER: return "coarser";
    }
    return "none";
}

void BeanConfig::get_name(char* out, size_t len) const {
    if (!out || len == 0) return;
    strncpy(out, name, len - 1);
    out[len - 1] = '\0';
}
