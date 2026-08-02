#pragma once
#include <cstdint>
#include <cstddef>
#include "../config/constants.h"

/**
 * BeanConfig - the active bag of coffee, cached from the cloud store.
 *
 * The server owns the active bean; this is the device's copy of it, delivered
 * over either channel: a BLE push from the dashboard's beans page (immediate,
 * when a browser is nearby) or the config fetch inside a cloud sync window
 * (convergence without a browser). Both carry the same server state, so the
 * two write paths never disagree.
 *
 * While a bean is configured, every logged grind is followed by the brew
 * entry screen (dose x ratio pre-set); with none, the flow is untouched -
 * off until provisioned, like cloud sync.
 *
 * Cross-task contract (same as CloudSync/WifiService): set_config() and
 * clear_config() may be called from the bluetooth task (deferred BLE writes)
 * or the main-loop task; they only touch NVS and set an atomic reload flag.
 * reload_if_dirty() runs on the consuming task before values are read.
 *
 * Advice is runtime-only: the server-computed finer/coarser verdict arrives
 * with each config fetch or brew upload response and resets at boot - an
 * offline grinder has no evidence to nag from.
 */
class BeanConfig {
public:
    enum class Advice : uint8_t { NONE, OK, FINER, COARSER };

    void init();

    void set_config(const char* name, float ratio, uint16_t brew_time_s);
    void clear_config();
    void reload_if_dirty();

    bool is_configured() const { return configured; }
    void get_name(char* out, size_t len) const;
    float get_ratio() const { return ratio; }
    uint16_t get_brew_time_s() const { return brew_time_s; }

    // Server-computed verdict (CloudSync writes, UI reads). Dismissal hides
    // the ready-screen chip until the verdict changes.
    void set_advice(Advice new_advice);
    Advice get_advice() const { return advice; }
    void dismiss_advice() { advice_dismissed = true; }
    bool is_advice_dismissed() const { return advice_dismissed; }
    const char* advice_name() const;

    // Server-computed bag level (consumption lives in the cloud store, summed
    // over the sessions attributed to this bag). Runtime-only like advice;
    // -1 means unknown (no bag size set, or no sync yet this boot).
    void set_bag_status(int16_t shots_remaining, bool low);
    int16_t get_shots_remaining() const { return shots_remaining; }
    bool is_bag_low() const { return bag_low; }
    void dismiss_bag_warning() { bag_dismissed = true; }
    bool is_bag_warning_dismissed() const { return bag_dismissed; }

private:
    char name[USER_BEAN_NAME_MAX_LENGTH + 1] = "";
    volatile float ratio = 0.0f;
    volatile uint16_t brew_time_s = 30;
    volatile bool configured = false;
    volatile bool config_dirty = false;
    volatile Advice advice = Advice::NONE;
    volatile bool advice_dismissed = false;
    volatile int16_t shots_remaining = -1;
    volatile bool bag_low = false;
    volatile bool bag_dismissed = false;

    void reload_config();
};

extern BeanConfig bean_config;
