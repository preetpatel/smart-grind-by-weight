#include "wifi_service.h"
#include <Arduino.h>
#include <WiFi.h>
#include <Preferences.h>
#include <esp_sntp.h>
#include <cstring>
#include "time_sync.h"
#include "cloud_sync.h"
#include "wifi_power.h"
#include "../bluetooth/manager.h"
#include "../controllers/grind_controller.h"

WifiService wifi_service;

namespace {
    constexpr const char* kNvsNamespace = "wifi";
    constexpr const char* kKeySsid = "ssid";
    constexpr const char* kKeyPass = "pass";
    constexpr const char* kKeyEnabled = "enabled";
    constexpr const char* kKeyTzRule = "tz_rule";
    constexpr const char* kKeyTzName = "tz_name";

    void copy_bounded(char* dst, size_t dst_len, const char* src) {
        if (!dst || dst_len == 0) return;
        dst[0] = '\0';
        if (src) {
            strncpy(dst, src, dst_len - 1);
            dst[dst_len - 1] = '\0';
        }
    }
}

void WifiService::init(GrindController* gc, BluetoothManager* bt) {
    grind_controller = gc;
    bluetooth_manager = bt;

    reload_config();
    update_idle_state();

    if (configured && enabled) {
        // Clock only. The uploader gets its own window after a grind rather
        // than riding this one - see the class comment.
        schedule_attempt(WIFI_BOOT_ATTEMPT_DELAY_MS, SyncWindowPurpose::CLOCK_ONLY);
        LOG_BLE("[WIFI] Configured for '%s' - boot clock sync in %ds\n",
                ssid, WIFI_BOOT_ATTEMPT_DELAY_MS / 1000);
    } else {
        LOG_BLE("[WIFI] %s\n", configured ? "Disabled by preference" : "No credentials stored");
    }

    initialized = true;
}

void WifiService::reload_config() {
    Preferences prefs;
    prefs.begin(kNvsNamespace, true);
    String s = prefs.getString(kKeySsid, "");
    String p = prefs.getString(kKeyPass, "");
    String rule = prefs.getString(kKeyTzRule, "");
    String name = prefs.getString(kKeyTzName, "");
    enabled = prefs.getBool(kKeyEnabled, true);
    prefs.end();

    copy_bounded(ssid, sizeof(ssid), s.c_str());
    copy_bounded(password, sizeof(password), p.c_str());
    copy_bounded(tz_name, sizeof(tz_name), name.c_str());
    configured = ssid[0] != '\0';

    TimeSync::apply_tz_rule(rule.c_str());
    config_dirty = false;
}

void WifiService::handle() {
    if (!initialized) return;
    uint32_t now = millis();

    if (config_dirty && state != State::CONNECTING && state != State::SYNCING
        && state != State::UPLOADING) {
        reload_config();
        update_idle_state();
    }

    switch (state) {
        case State::NOT_CONFIGURED:
        case State::DISABLED_BY_USER:
            return;

        case State::IDLE: {
            // Cloud sync is the second window consumer: a settled grind brings
            // a window up half an hour later (docs/CLOUD_SYNC.md).
            SyncWindowDecision decision = sync_window_due(
                now, attempt_scheduled, next_attempt_ms, scheduled_purpose,
                sync_requested, cloud_sync.wants_window());
            if (decision.due && window_allowed()) {
                start_attempt(decision.purpose);
            }
            break;
        }

        case State::CONNECTING:
            if (!window_allowed()) {
                finish_attempt(LastResult::ABORTED);
            } else if (WiFi.status() == WL_CONNECTED) {
                bool stale = sync_clock_is_stale(now, have_sntp, last_sntp_ms,
                                                 WIFI_CLOCK_REFRESH_INTERVAL_MS);
                if (sync_window_needs_sntp(window_purpose, stale)) {
                    LOG_BLE("[WIFI] Connected to '%s' (%s) - starting SNTP\n",
                            ssid, WiFi.localIP().toString().c_str());
                    start_sntp(now);
                } else {
                    // Cloud window with a clock that is still good: spending
                    // WIFI_SNTP_TIMEOUT_MS on air to re-learn the same time is
                    // pure radio time. Go straight to the uploader.
                    LOG_BLE("[WIFI] Connected to '%s' (%s) - clock fresh, skipping SNTP\n",
                            ssid, WiFi.localIP().toString().c_str());
                    begin_upload_or_finish(LastResult::SUCCESS);
                }
            } else if (now - attempt_started_ms > WIFI_CONNECT_TIMEOUT_MS) {
                LOG_BLE("[WIFI] Association timed out\n");
                finish_attempt(LastResult::WIFI_FAILED);
            }
            break;

        case State::SYNCING:
            if (!window_allowed()) {
                finish_attempt(LastResult::ABORTED);
            } else if (sntp_get_sync_status() == SNTP_SYNC_STATUS_COMPLETED) {
                TimeSync::mark_synced_from_sntp();
                have_sntp = true;
                last_sntp_ms = now;
                char formatted[32];
                TimeSync::format_local_time(formatted, sizeof(formatted), "%Y-%m-%d %H:%M:%S");
                LOG_BLE("[WIFI] Clock synced via SNTP: %s (epoch %lu)\n",
                        formatted, (unsigned long)TimeSync::now_epoch());
                begin_upload_or_finish(LastResult::SUCCESS);
            } else if (now - attempt_started_ms > WIFI_SNTP_TIMEOUT_MS) {
                LOG_BLE("[WIFI] SNTP timed out\n");
                // The association is up even though NTP never answered -
                // still worth spending it on the cloud sync run.
                begin_upload_or_finish(LastResult::SNTP_FAILED);
            }
            break;

        case State::UPLOADING:
            if (!window_allowed()) {
                cloud_sync.abort_run();
                finish_attempt(pending_time_result);
            } else {
                // One blocking HTTP operation per pass; gating is re-checked
                // between operations so a starting grind tears the window down.
                CloudSync::StepResult step = cloud_sync.step();
                if (step != CloudSync::StepResult::RUNNING) {
                    // The uploader has had its turn. Any retry this schedules
                    // only owes the clock (sync_retry_after) - CloudSync
                    // re-asks for a window of its own when it still has work.
                    finish_attempt(pending_time_result);
                }
            }
            break;
    }
}

// Drive esp_sntp directly instead of Arduino's configTime(): that wrapper
// calls setTimeZone(), which overwrites the TZ env var - and with it the
// provisioned POSIX DST rule - with a UTC string. SNTP sets UTC system time
// only; local time stays TimeSync's business. Reset the sync status first so a
// COMPLETED left over from a previous attempt can't register as an instant
// (fake) success. Server name pointers are kept, not copied, by lwip - the
// config macros are string literals.
void WifiService::start_sntp(uint32_t now) {
    esp_sntp_stop();
    esp_sntp_setoperatingmode(ESP_SNTP_OPMODE_POLL);
    esp_sntp_setservername(0, WIFI_NTP_SERVER_1);
    esp_sntp_setservername(1, WIFI_NTP_SERVER_2);
    sntp_set_sync_status(SNTP_SYNC_STATUS_RESET);
    esp_sntp_init();
    attempt_started_ms = now;
    state = State::SYNCING;
}

// The clock side of the window is settled; hand the still-open connection to
// the cloud uploader when this window was opened for it. A boot window closes
// here instead, which is what keeps the uploader's TLS handshake off the
// startup current draw.
void WifiService::begin_upload_or_finish(LastResult time_result) {
    esp_sntp_stop();
    if (window_purpose == SyncWindowPurpose::CLOUD_SYNC && cloud_sync.should_run()) {
        pending_time_result = time_result;
        cloud_sync.begin_run();
        state = State::UPLOADING;
    } else {
        finish_attempt(time_result);
    }
}

bool WifiService::window_allowed() const {
    if (grind_controller && grind_controller->is_active()) return false;
    if (bluetooth_manager &&
        (bluetooth_manager->is_updating() || bluetooth_manager->is_data_export_active())) {
        return false;
    }
    return true;
}

void WifiService::start_attempt(SyncWindowPurpose purpose) {
    sync_requested = false;
    attempt_scheduled = false;
    window_purpose = purpose;
    LOG_BLE("[WIFI] Connecting to '%s' (%s window)...\n", ssid,
            purpose == SyncWindowPurpose::CLOUD_SYNC ? "cloud" : "clock");
    last_tx_power_qdbm = 0;
    int8_t applied_qdbm = 0;
    if (!WiFi.mode(WIFI_STA) ||
        !configure_wifi_power(WIFI_MAX_TX_POWER_QDBM, &applied_qdbm)) {
        LOG_BLE("[WIFI] Radio power configuration failed; closing window\n");
        finish_attempt(LastResult::WIFI_FAILED);
        return;
    }
    last_tx_power_qdbm = applied_qdbm;
    LOG_BLE("[WIFI] TX ceiling %.2f dBm, minimum modem sleep enabled\n",
            applied_qdbm / 4.0f);
    WiFi.begin(ssid, password);
    attempt_started_ms = millis();
    state = State::CONNECTING;
}

void WifiService::schedule_attempt(uint32_t delay_ms, SyncWindowPurpose purpose) {
    next_attempt_ms = millis() + delay_ms;
    scheduled_purpose = purpose;
    attempt_scheduled = true;
}

void WifiService::finish_attempt(LastResult result) {
    esp_sntp_stop();
    radio_off();
    last_result = result;

    switch (result) {
        case LastResult::SUCCESS:
            // Nothing is rescheduled: the next window is whatever a grind or a
            // provisioning write asks for. Clearing attempt_scheduled is what
            // stops the satisfied deadline from firing again immediately.
            backoff_ms = WIFI_RETRY_BACKOFF_START_MS;
            attempt_scheduled = false;
            break;
        case LastResult::ABORTED: {
            // The device got busy (grind/OTA/export). Whatever tore the
            // window down, the uploader must not ride the retry back a minute
            // later with the motor still warm: the quiet delay restarts here,
            // and the schedule only re-owes the clock when the aborted errand
            // was the clock itself (sync_retry_after).
            cloud_sync.defer_window();
            SyncRetryDecision retry = sync_retry_after(window_purpose, true);
            if (retry.reschedule) {
                schedule_attempt(WIFI_RETRY_BACKOFF_START_MS, retry.purpose);
                LOG_BLE("[WIFI] Attempt aborted (device busy), retrying in %lus\n",
                        (unsigned long)(WIFI_RETRY_BACKOFF_START_MS / 1000));
            } else {
                LOG_BLE("[WIFI] Attempt aborted (device busy); next window follows the grind delay\n");
            }
            break;
        }
        default: {
            SyncRetryDecision retry = sync_retry_after(window_purpose, false);
            schedule_attempt(backoff_ms, retry.purpose);
            LOG_BLE("[WIFI] Attempt failed, retrying in %lus\n",
                    (unsigned long)(backoff_ms / 1000));
            backoff_ms *= 2;
            if (backoff_ms > WIFI_RETRY_BACKOFF_MAX_MS) backoff_ms = WIFI_RETRY_BACKOFF_MAX_MS;
            break;
        }
    }

    update_idle_state();
}

void WifiService::radio_off() {
    WiFi.disconnect(true /*wifioff*/, true /*eraseap*/);
    WiFi.mode(WIFI_OFF);
}

void WifiService::update_idle_state() {
    if (!configured) {
        state = State::NOT_CONFIGURED;
    } else if (!enabled) {
        state = State::DISABLED_BY_USER;
    } else {
        state = State::IDLE;
    }
}

void WifiService::set_credentials(const char* new_ssid, const char* new_pass,
                                  const char* tz_rule, const char* new_tz_name) {
    if (!new_ssid || new_ssid[0] == '\0') return;

    Preferences prefs;
    prefs.begin(kNvsNamespace, false);
    prefs.putString(kKeySsid, new_ssid);
    prefs.putString(kKeyPass, new_pass ? new_pass : "");
    prefs.putString(kKeyTzRule, tz_rule ? tz_rule : "");
    prefs.putString(kKeyTzName, new_tz_name ? new_tz_name : "");
    prefs.putBool(kKeyEnabled, true);  // Provisioning implies the user wants it on
    prefs.end();

    config_dirty = true;
    sync_requested = true;
    LOG_BLE("[WIFI] Credentials stored for '%s' (tz: %s)\n",
            new_ssid, (tz_rule && tz_rule[0]) ? tz_rule : "none");
}

void WifiService::forget_credentials() {
    Preferences prefs;
    prefs.begin(kNvsNamespace, false);
    prefs.clear();
    prefs.end();

    config_dirty = true;
    sync_requested = false;
    LOG_BLE("[WIFI] Credentials forgotten\n");
}

void WifiService::set_enabled(bool on) {
    Preferences prefs;
    prefs.begin(kNvsNamespace, false);
    prefs.putBool(kKeyEnabled, on);
    prefs.end();

    config_dirty = true;
    if (on) sync_requested = true;  // Toggling on syncs right away
    LOG_BLE("[WIFI] %s by user\n", on ? "Enabled" : "Disabled");
}

void WifiService::request_sync_now() {
    sync_requested = true;
}

void WifiService::get_ssid(char* out, size_t len) const {
    copy_bounded(out, len, ssid);
}

void WifiService::get_tz_name(char* out, size_t len) const {
    copy_bounded(out, len, tz_name);
}

const char* WifiService::state_name() const {
    switch (state) {
        case State::NOT_CONFIGURED: return "not_configured";
        case State::DISABLED_BY_USER: return "disabled";
        case State::IDLE: return "idle";
        case State::CONNECTING: return "connecting";
        case State::SYNCING: return "syncing";
        case State::UPLOADING: return "uploading";
    }
    return "unknown";
}

const char* WifiService::last_result_name() const {
    switch (last_result) {
        case LastResult::NONE: return "none";
        case LastResult::SUCCESS: return "success";
        case LastResult::WIFI_FAILED: return "wifi_failed";
        case LastResult::SNTP_FAILED: return "sntp_failed";
        case LastResult::ABORTED: return "aborted";
    }
    return "unknown";
}
