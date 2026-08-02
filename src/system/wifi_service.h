#pragma once
#include <cstdint>
#include "../config/constants.h"

class GrindController;
class BluetoothManager;

/**
 * WifiService - duty-cycled WiFi connection manager.
 *
 * Owns the WiFi connection lifecycle: credentials (NVS "wifi" namespace),
 * grind-state gating, retry backoff, and radio teardown. It knows nothing
 * about why a connection is wanted - consumers request connection windows.
 * Phase 1 has a single consumer: SNTP time sync, requested at boot and then
 * on a daily floor. A future session uploader plugs in as a second consumer
 * without touching the lifecycle logic.
 *
 * Runs from the Arduino main loop (Core 1), which is otherwise nearly idle.
 * The radio is only up for the seconds an attempt takes, and an attempt is
 * never started - and is torn down - while a grind, OTA update, or BLE data
 * export is active, so WiFi traffic cannot contend with the 20ms grind loop
 * or a bulk BLE transfer.
 *
 * Cross-task contract: set_credentials()/forget_credentials()/set_enabled()
 * may be called from the bluetooth task (deferred BLE writes) or the UI task.
 * They only touch NVS and set an atomic reload flag; all WiFi/SNTP calls and
 * cached config strings stay on the main-loop task.
 */
class WifiService {
public:
    // DISABLED_BY_USER dodges Arduino's `#define DISABLED 0x00` in esp32-hal-gpio.h
    enum class State : uint8_t {
        NOT_CONFIGURED,   // No credentials stored
        DISABLED_BY_USER, // Credentials stored but service toggled off
        IDLE,             // Radio off, waiting for the next sync window
        CONNECTING,       // WiFi association in progress
        SYNCING,          // Associated, waiting for the NTP response
        UPLOADING         // Associated, cloud sync run in progress (second consumer)
    };

    enum class LastResult : uint8_t {
        NONE,         // No attempt finished yet this boot
        SUCCESS,      // Clock synced
        WIFI_FAILED,  // Association failed (bad credentials / out of range)
        SNTP_FAILED,  // Connected but no NTP response
        ABORTED       // Torn down because a grind/OTA/export started
    };

    void init(GrindController* grind_controller, BluetoothManager* bluetooth_manager);
    void handle();  // Call from the main loop

    // Provisioning (BLE write via flasher). Persists to NVS and triggers an
    // immediate sync attempt. tz_rule/tz_name may be empty.
    void set_credentials(const char* ssid, const char* pass,
                         const char* tz_rule, const char* tz_name);
    void forget_credentials();
    void set_enabled(bool enabled);  // Persisted; DISABLED keeps credentials
    void request_sync_now();         // Bring the next window forward to "now"

    bool is_enabled() const { return enabled; }
    bool is_configured() const { return configured; }
    State get_state() const { return state; }
    LastResult get_last_result() const { return last_result; }

    // Copy accessors so callers on other tasks never hold references into
    // buffers the main-loop task rewrites on a config reload.
    void get_ssid(char* out, size_t len) const;
    void get_tz_name(char* out, size_t len) const;

    const char* state_name() const;
    const char* last_result_name() const;

private:
    GrindController* grind_controller = nullptr;
    BluetoothManager* bluetooth_manager = nullptr;
    bool initialized = false;

    // Cached config, reloaded from NVS on the main-loop task when dirty
    char ssid[WIFI_MAX_SSID_LEN + 1] = "";
    char password[WIFI_MAX_PASS_LEN + 1] = "";
    char tz_name[WIFI_MAX_TZ_NAME_LEN + 1] = "";
    volatile bool configured = false;
    volatile bool enabled = true;
    volatile bool config_dirty = false;

    volatile State state = State::NOT_CONFIGURED;
    volatile LastResult last_result = LastResult::NONE;
    volatile bool sync_requested = false;

    uint32_t next_attempt_ms = 0;   // millis() timestamp of the next window
    uint32_t attempt_started_ms = 0;
    uint32_t backoff_ms = WIFI_RETRY_BACKOFF_START_MS;
    // The window's time-sync outcome, held while the cloud sync run (the
    // second window consumer) finishes; finish_attempt() reports it.
    LastResult pending_time_result = LastResult::NONE;

    void reload_config();
    bool window_allowed() const;  // Grind/OTA/export gating
    void start_attempt();
    void begin_upload_or_finish(LastResult time_result);
    void finish_attempt(LastResult result);
    void radio_off();
    void update_idle_state();  // Map configured/enabled onto the idle states
};

extern WifiService wifi_service;
