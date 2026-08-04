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

    /**
     * What the bag states. A bag gives a recipe, not a number - "dose 20.5 g,
     * yield 27-30 g, time 25-31 s" - and those numbers are frequently
     * inconsistent with its own stated ratio, so the range is stored as typed
     * rather than derived from the ratio. Zeroed fields mean "not stated".
     */
    struct Config {
        const char* name;
        float ratio;
        uint16_t brew_time_s;
        float dose_g;  // reference dose the yield range is quoted at
        float yield_lo_g;
        float yield_hi_g;
        uint16_t time_lo_s;
        uint16_t time_hi_s;
    };

    /**
     * The recipe resolved for the dose this grind actually delivered - what
     * the brew entry screen pre-fills from and judges against.
     */
    struct Recipe {
        float yield_lo_g;
        float yield_hi_g;
        // false when the band is the derived tolerance around dose x ratio
        // rather than numbers off a bag. The screen says which.
        bool yield_stated;
        float default_yield_g;
        // hi <= lo means the bag states no target time. There is deliberately
        // no derived fallback: a band around the pinned default would invent a
        // tolerance nobody wrote down.
        float time_lo_s;
        float time_hi_s;
        uint16_t default_time_s;
    };

    void init();

    void set_config(const Config& config);
    void clear_config();
    void reload_if_dirty();
    // True when the cached copy already matches, so a converging cloud fetch
    // doesn't rewrite NVS on every sync window.
    bool matches(const Config& config) const;

    bool is_configured() const { return configured; }
    void get_name(char* out, size_t len) const;
    float get_ratio() const { return ratio; }
    uint16_t get_brew_time_s() const { return brew_time_s; }
    Recipe recipe_for_dose(float dose_g) const;

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
    // The bag's stated recipe; 0 throughout for a bean that only carries a
    // ratio, which is every bean created before ranges existed.
    volatile float dose_ref_g = 0.0f;
    volatile float yield_lo_g = 0.0f;
    volatile float yield_hi_g = 0.0f;
    volatile uint16_t time_lo_s = 0;
    volatile uint16_t time_hi_s = 0;
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
