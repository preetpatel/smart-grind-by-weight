#include "bean_config.h"
#include <Arduino.h>
#include <Preferences.h>
#include <cmath>
#include <cstring>

BeanConfig bean_config;

namespace {
    constexpr const char* kNvsNamespace = "bean";
    constexpr const char* kKeyName = "name";
    constexpr const char* kKeyRatio = "ratio";
    constexpr const char* kKeyBrewSec = "brewsec";
    constexpr const char* kKeySet = "set";
    constexpr const char* kKeyDose = "dose";
    constexpr const char* kKeyYieldLo = "ylo";
    constexpr const char* kKeyYieldHi = "yhi";
    constexpr const char* kKeyTimeLo = "tlo";
    constexpr const char* kKeyTimeHi = "thi";
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
    dose_ref_g = prefs.getFloat(kKeyDose, 0.0f);
    yield_lo_g = prefs.getFloat(kKeyYieldLo, 0.0f);
    yield_hi_g = prefs.getFloat(kKeyYieldHi, 0.0f);
    time_lo_s = (uint16_t)prefs.getUShort(kKeyTimeLo, 0);
    time_hi_s = (uint16_t)prefs.getUShort(kKeyTimeHi, 0);
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

bool BeanConfig::matches(const Config& config) const {
    if (!configured || !config.name) return false;
    return strncmp(name, config.name, sizeof(name)) == 0
           && fabsf(ratio - config.ratio) < 0.001f
           && brew_time_s == config.brew_time_s
           && fabsf(dose_ref_g - config.dose_g) < 0.01f
           && fabsf(yield_lo_g - config.yield_lo_g) < 0.01f
           && fabsf(yield_hi_g - config.yield_hi_g) < 0.01f
           && time_lo_s == config.time_lo_s
           && time_hi_s == config.time_hi_s;
}

void BeanConfig::set_config(const Config& config) {
    if (!config.name || !config.name[0] || !(config.ratio > 0.0f)) return;
    Preferences prefs;
    prefs.begin(kNvsNamespace, false);
    prefs.putString(kKeyName, config.name);
    prefs.putFloat(kKeyRatio, config.ratio);
    prefs.putUShort(kKeyBrewSec, config.brew_time_s > 0 ? config.brew_time_s : 30);
    prefs.putFloat(kKeyDose, config.dose_g);
    prefs.putFloat(kKeyYieldLo, config.yield_lo_g);
    prefs.putFloat(kKeyYieldHi, config.yield_hi_g);
    prefs.putUShort(kKeyTimeLo, config.time_lo_s);
    prefs.putUShort(kKeyTimeHi, config.time_hi_s);
    prefs.putBool(kKeySet, true);
    prefs.end();

    config_dirty = true;
    LOG_BLE("[BEAN] Active bean set: %s (1:%.2f over %us, yield %.1f-%.1fg @ %.1fg, time %u-%us)\n",
            config.name, config.ratio, (unsigned)config.brew_time_s,
            config.yield_lo_g, config.yield_hi_g, config.dose_g,
            (unsigned)config.time_lo_s, (unsigned)config.time_hi_s);
}

BeanConfig::Recipe BeanConfig::recipe_for_dose(float dose_g) const {
    Recipe recipe = {};

    // The bag's yield range wins where it states one, scaled to the dose this
    // grind actually delivered: the range is quoted at a reference dose, so a
    // smaller dose targets proportionally less. The implied ratio beats the
    // bag's own stated one, which frequently disagrees with its range.
    bool stated = (yield_hi_g > yield_lo_g) && (yield_lo_g > 0.0f) && (dose_ref_g > 0.0f);
    if (stated) {
        float scale = dose_g / dose_ref_g;
        recipe.yield_lo_g = yield_lo_g * scale;
        recipe.yield_hi_g = yield_hi_g * scale;
        recipe.yield_stated = true;
    } else {
        float expected = dose_g * ratio;
        float tolerance = expected * (USER_BREW_ON_TARGET_BAND_PCT / 100.0f);
        recipe.yield_lo_g = expected - tolerance;
        recipe.yield_hi_g = expected + tolerance;
        recipe.yield_stated = false;
    }
    recipe.default_yield_g = (recipe.yield_lo_g + recipe.yield_hi_g) * 0.5f;

    if (time_hi_s > time_lo_s && time_lo_s > 0) {
        recipe.time_lo_s = (float)time_lo_s;
        recipe.time_hi_s = (float)time_hi_s;
        recipe.default_time_s = (uint16_t)((time_lo_s + time_hi_s + 1) / 2);
    } else {
        recipe.time_lo_s = 0.0f;
        recipe.time_hi_s = 0.0f;
        recipe.default_time_s = brew_time_s > 0 ? brew_time_s : 30;
    }
    return recipe;
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
