#include "cloud_sync.h"
#include <Arduino.h>
#include <LittleFS.h>
#include <Preferences.h>
#include <esp_heap_caps.h>
#include <esp_http_client.h>
#if __has_include(<esp_crt_bundle.h>)
#include <esp_crt_bundle.h>
#define CLOUD_SYNC_HAS_CRT_BUNDLE 1
#endif
#include <cstring>
#include <cstdlib>
#include "time_sync.h"
#include "bean_config.h"
#include "brew_log.h"
#include "../logging/grind_logging.h"
#include "../system/statistics_manager.h"

CloudSync cloud_sync;

namespace {
    constexpr const char* kNvsNamespace = "cloudsync";
    constexpr const char* kKeyUrl = "url";
    constexpr const char* kKeyStore = "store";
    constexpr const char* kKeyUploadKey = "upkey";
    constexpr const char* kKeyViewKey = "viewkey";
    constexpr const char* kKeyEnabled = "enabled";

    void copy_bounded(char* dst, size_t dst_len, const char* src) {
        if (!dst || dst_len == 0) return;
        dst[0] = '\0';
        if (src) {
            strncpy(dst, src, dst_len - 1);
            dst[dst_len - 1] = '\0';
        }
    }

    // Flat-key JSON scanning, same spirit as the manifest "want" parse - the
    // device never carries a JSON parser. Copies up to the next unescaped
    // quote; names containing '"' arrive truncated, which is acceptable for a
    // display string.
    bool json_find_string(const char* json, const char* key, char* out, size_t out_len) {
        if (!json || !key || !out || out_len == 0) return false;
        char needle[48];
        snprintf(needle, sizeof(needle), "\"%s\":\"", key);
        const char* cursor = strstr(json, needle);
        if (!cursor) return false;
        cursor += strlen(needle);
        size_t i = 0;
        while (*cursor && *cursor != '"' && i < out_len - 1) out[i++] = *cursor++;
        out[i] = '\0';
        return true;
    }

    bool json_find_number(const char* json, const char* key, double* out) {
        if (!json || !key || !out) return false;
        char needle[48];
        snprintf(needle, sizeof(needle), "\"%s\":", key);
        const char* cursor = strstr(json, needle);
        if (!cursor) return false;
        cursor += strlen(needle);
        char* end = nullptr;
        double value = strtod(cursor, &end);
        if (end == cursor) return false;
        *out = value;
        return true;
    }
}

void CloudSync::init() {
    reload_config();
    update_idle_state();
    // Sessions ground while the server was unreachable are swept by the
    // opportunistic run inside the guaranteed boot window (should_run());
    // wants_window() only tracks sessions flushed since this boot.
    last_seen_storage_version = grind_logger.get_session_storage_version();
    last_synced_storage_version = last_seen_storage_version;
    if (configured) {
        LOG_BLE("[CLOUD] Store %s on %s (%s)\n", store_id, server_url,
                enabled ? "enabled" : "disabled");
    }
    initialized = true;
}

void CloudSync::reload_config() {
    Preferences prefs;
    prefs.begin(kNvsNamespace, true);
    String url = prefs.getString(kKeyUrl, "");
    String store = prefs.getString(kKeyStore, "");
    String up = prefs.getString(kKeyUploadKey, "");
    String view = prefs.getString(kKeyViewKey, "");
    enabled = prefs.getBool(kKeyEnabled, false);
    prefs.end();

    copy_bounded(server_url, sizeof(server_url), url.c_str());
    copy_bounded(store_id, sizeof(store_id), store.c_str());
    copy_bounded(upload_key, sizeof(upload_key), up.c_str());
    copy_bounded(view_key, sizeof(view_key), view.c_str());

    // Trailing slash would double up when paths are appended
    size_t url_len = strlen(server_url);
    if (url_len > 0 && server_url[url_len - 1] == '/') server_url[url_len - 1] = '\0';

    configured = server_url[0] != '\0' && store_id[0] != '\0' && upload_key[0] != '\0';
    config_dirty = false;
}

void CloudSync::update_idle_state() {
    if (state == State::SYNCING) return;  // Run outcome decides the next state
    if (!configured) {
        state = State::NOT_CONFIGURED;
    } else if (!enabled) {
        state = State::DISABLED_BY_USER;
    } else {
        state = State::IDLE;
    }
}

void CloudSync::set_config(const char* url, const char* new_store_id,
                           const char* new_upload_key, const char* new_view_key) {
    if (!url || !url[0] || !new_store_id || !new_store_id[0]
        || !new_upload_key || !new_upload_key[0]) {
        return;
    }
    Preferences prefs;
    prefs.begin(kNvsNamespace, false);
    prefs.putString(kKeyUrl, url);
    prefs.putString(kKeyStore, new_store_id);
    prefs.putString(kKeyUploadKey, new_upload_key);
    prefs.putString(kKeyViewKey, new_view_key ? new_view_key : "");
    prefs.putBool(kKeyEnabled, true);  // Provisioning implies the user wants it on
    prefs.end();

    config_dirty = true;
    LOG_BLE("[CLOUD] Store provisioned: %s\n", new_store_id);
}

void CloudSync::forget_config() {
    Preferences prefs;
    prefs.begin(kNvsNamespace, false);
    prefs.clear();
    prefs.end();

    config_dirty = true;
    LOG_BLE("[CLOUD] Store configuration forgotten\n");
}

void CloudSync::set_enabled(bool on) {
    Preferences prefs;
    prefs.begin(kNvsNamespace, false);
    prefs.putBool(kKeyEnabled, on);
    prefs.end();

    config_dirty = true;
    LOG_BLE("[CLOUD] %s by user\n", on ? "Enabled" : "Disabled");
}

bool CloudSync::has_unsynced_sessions() const {
    return grind_logger.get_session_storage_version() != last_synced_storage_version;
}

bool CloudSync::should_run() const {
    return initialized && configured && enabled;
}

bool CloudSync::wants_window() {
    if (!initialized) return false;
    if (config_dirty && state != State::SYNCING) {
        reload_config();
        update_idle_state();
    }
    if (!configured || !enabled) return false;

    uint32_t version = grind_logger.get_session_storage_version();
    if (version != last_seen_storage_version) {
        last_seen_storage_version = version;
        storage_changed_ms = millis();
    }
    // A queued brew record wants a window of its own: the shot was logged
    // minutes after the grind, well past the session's settle delay, and the
    // response brings back fresh advice for the ready screen.
    if (version == last_synced_storage_version) return brew_log.pending_count() > 0;
    // Settle delay: skip windows while the user might still fire a top-up
    // pulse; the daily window still sweeps everything regardless.
    return (millis() - storage_changed_ms) >= CLOUD_SYNC_SETTLE_MS;
}

void CloudSync::begin_run() {
    run_phase = RunPhase::MANIFEST;
    want_ids = nullptr;
    want_count = 0;
    want_index = 0;
    run_uploaded = 0;
    brew_cursor = 0;
    config_refreshed = false;
    run_storage_version = grind_logger.get_session_storage_version();
    state = State::SYNCING;
    LOG_BLE("[CLOUD] Sync run starting\n");
}

void CloudSync::end_run(LastResult result) {
    if (want_ids) {
        free(want_ids);
        want_ids = nullptr;
    }
    last_result = result;
    last_run_uploaded = run_uploaded;
    if (result == LastResult::SUCCESS) {
        // A session flushed mid-run bumps the live version past the snapshot
        // we synced, so wants_window() stays true and the next window mops up.
        last_synced_storage_version = run_storage_version;
        if (TimeSync::is_synced()) last_success_epoch = TimeSync::now_epoch();
    }
    state = State::IDLE;
    update_idle_state();
    LOG_BLE("[CLOUD] Sync run finished: %s (%u/%u sessions uploaded)\n",
            last_result_name(), run_uploaded, last_run_wanted);
}

void CloudSync::abort_run() {
    if (state == State::SYNCING) end_run(LastResult::ABORTED);
}

CloudSync::StepResult CloudSync::step() {
    if (state != State::SYNCING) return StepResult::FAILED;
    StepResult result;
    switch (run_phase) {
        case RunPhase::MANIFEST:     result = step_manifest(); break;
        case RunPhase::UPLOAD:       result = step_upload(); break;
        case RunPhase::BREW_UPLOAD:  result = step_brew_upload(); break;
        case RunPhase::CONFIG_FETCH: result = step_config_fetch(); break;
        default:                     result = step_snapshot(); break;
    }
    if (result == StepResult::DONE) {
        end_run(run_uploaded < last_run_wanted ? LastResult::PARTIAL : LastResult::SUCCESS);
    } else if (result == StepResult::FAILED) {
        end_run(run_uploaded > 0 ? LastResult::PARTIAL : LastResult::FAILED);
    }
    return result;
}

const char* CloudSync::device_id() {
    if (!device_id_hex[0]) {
        uint64_t mac = ESP.getEfuseMac();
        snprintf(device_id_hex, sizeof(device_id_hex), "%012llx", (unsigned long long)mac);
    }
    return device_id_hex;
}

// ---- run phases ------------------------------------------------------------

// Builds the manifest from the 24-byte headers already on flash and asks the
// server which sessions it lacks.
CloudSync::StepResult CloudSync::step_manifest() {
    const size_t body_cap = 32 + (size_t)CLOUD_SYNC_MAX_MANIFEST_ENTRIES * CLOUD_SYNC_MANIFEST_ENTRY_BYTES;
    char* body = (char*)heap_caps_malloc(body_cap, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    char* response = (char*)heap_caps_malloc(CLOUD_SYNC_RESPONSE_BUFFER_BYTES, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!body || !response) {
        if (body) free(body);
        if (response) free(response);
        LOG_BLE("[CLOUD] Manifest buffer allocation failed\n");
        return StepResult::FAILED;
    }

    size_t pos = 0;
    pos += snprintf(body + pos, body_cap - pos, "{\"sessions\":[");
    uint16_t entries = 0;

    File dir = LittleFS.open(GRIND_SESSIONS_DIR);
    if (dir && dir.isDirectory()) {
        File file = dir.openNextFile();
        while (file && entries < CLOUD_SYNC_MAX_MANIFEST_ENTRIES) {
            TimeSeriesSessionHeader header;
            if (!file.isDirectory()
                && file.read((uint8_t*)&header, sizeof(header)) == sizeof(header)
                && header.session_size > 0) {
                pos += snprintf(body + pos, body_cap - pos,
                    "%s{\"session_id\":%lu,\"session_timestamp\":%lu,"
                    "\"session_size\":%lu,\"checksum\":%lu}",
                    entries ? "," : "",
                    (unsigned long)header.session_id,
                    (unsigned long)header.session_timestamp,
                    (unsigned long)header.session_size,
                    (unsigned long)header.checksum);
                entries++;
            }
            file.close();
            file = dir.openNextFile();
        }
        dir.close();
    }
    pos += snprintf(body + pos, body_cap - pos, "]}");

    int status = http_request("POST", "/manifest", "application/json",
                              (const uint8_t*)body, pos,
                              response, CLOUD_SYNC_RESPONSE_BUFFER_BYTES);
    free(body);

    if (status != 200) {
        LOG_BLE("[CLOUD] Manifest request failed (HTTP %d)\n", status);
        free(response);
        return StepResult::FAILED;
    }

    // Parse {"want":[1,2,3]} - the only JSON this device ever reads.
    want_ids = (uint32_t*)heap_caps_malloc(
        sizeof(uint32_t) * CLOUD_SYNC_MAX_MANIFEST_ENTRIES, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    want_count = 0;
    const char* cursor = strstr(response, "\"want\"");
    if (want_ids && cursor && (cursor = strchr(cursor, '['))) {
        cursor++;
        while (*cursor && *cursor != ']' && want_count < CLOUD_SYNC_MAX_MANIFEST_ENTRIES) {
            if (*cursor >= '0' && *cursor <= '9') {
                want_ids[want_count++] = strtoul(cursor, (char**)&cursor, 10);
            } else {
                cursor++;
            }
        }
    }
    free(response);
    if (!want_ids) return StepResult::FAILED;

    last_run_wanted = want_count;
    LOG_BLE("[CLOUD] Server holds %u of %u sessions, wants %u\n",
            entries - want_count, entries, want_count);
    run_phase = want_count > 0 ? RunPhase::UPLOAD : RunPhase::BREW_UPLOAD;
    return StepResult::RUNNING;
}

// Uploads one wanted session file per step, verbatim bytes.
CloudSync::StepResult CloudSync::step_upload() {
    if (want_index >= want_count || run_uploaded >= CLOUD_SYNC_MAX_UPLOADS_PER_RUN) {
        run_phase = RunPhase::BREW_UPLOAD;
        return StepResult::RUNNING;
    }
    uint32_t session_id = want_ids[want_index++];

    char filename[64];
    snprintf(filename, sizeof(filename), SESSION_FILE_FORMAT, (unsigned long)session_id);
    File file = LittleFS.open(filename, "r");
    if (!file) {
        // Purged between manifest and now - not an error, just move on.
        return StepResult::RUNNING;
    }
    size_t size = file.size();
    uint8_t* blob = (uint8_t*)heap_caps_malloc(size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!blob) {
        file.close();
        LOG_BLE("[CLOUD] Session buffer allocation failed (%zu bytes)\n", size);
        return StepResult::FAILED;
    }
    bool read_ok = file.read(blob, size) == size;
    file.close();
    if (!read_ok) {
        free(blob);
        return StepResult::RUNNING;  // Skip the unreadable file, keep going
    }

    int status = http_request("POST", "/sessions", "application/octet-stream",
                              blob, size, nullptr, 0);
    free(blob);

    if (status == 201 || status == 200) {  // stored or already-known duplicate
        run_uploaded++;
        return StepResult::RUNNING;
    }
    if (status == 422) {
        // The server rejected this file as corrupt; uploading it again will
        // never succeed. Skip it rather than wedging the whole store.
        LOG_BLE("[CLOUD] Session %lu rejected as corrupt, skipping\n", (unsigned long)session_id);
        run_uploaded++;
        return StepResult::RUNNING;
    }
    LOG_BLE("[CLOUD] Session %lu upload failed (HTTP %d)\n", (unsigned long)session_id, status);
    return StepResult::FAILED;
}

// Applies the {bean, advice} payload both device-facing endpoints return:
// the active bean lands in the NVS cache (the server is the source of truth,
// so a bean switched in the dashboard converges here without a browser) and
// the verdict lands on the ready screen.
void CloudSync::apply_device_config(const char* response) {
    if (!response) return;
    config_refreshed = true;

    if (strstr(response, "\"bean\":null")) {
        bean_config.reload_if_dirty();
        if (bean_config.is_configured()) bean_config.clear_config();
    } else {
        char name[USER_BEAN_NAME_MAX_LENGTH + 1];
        double ratio = 0.0;
        double brew_time = 30.0;
        if (json_find_string(response, "name", name, sizeof(name))
            && json_find_number(response, "ratio", &ratio) && ratio > 0.0) {
            json_find_number(response, "brew_time_s", &brew_time);

            // The bag's stated recipe. Absent keys (an older server, or a bean
            // carrying only a ratio) leave these 0 = not stated.
            double dose = 0.0, yield_lo = 0.0, yield_hi = 0.0, time_lo = 0.0, time_hi = 0.0;
            json_find_number(response, "dose_g", &dose);
            json_find_number(response, "yield_min_g", &yield_lo);
            json_find_number(response, "yield_max_g", &yield_hi);
            json_find_number(response, "time_min_s", &time_lo);
            json_find_number(response, "time_max_s", &time_hi);

            BeanConfig::Config config = {};
            config.name = name;
            config.ratio = (float)ratio;
            config.brew_time_s = (uint16_t)brew_time;
            config.dose_g = (float)dose;
            config.yield_lo_g = (float)yield_lo;
            config.yield_hi_g = (float)yield_hi;
            config.time_lo_s = (uint16_t)time_lo;
            config.time_hi_s = (uint16_t)time_hi;

            bean_config.reload_if_dirty();
            if (!bean_config.matches(config)) bean_config.set_config(config);
        }
    }

    char verdict[12];
    if (json_find_string(response, "verdict", verdict, sizeof(verdict))) {
        BeanConfig::Advice advice = BeanConfig::Advice::NONE;
        if (strcmp(verdict, "finer") == 0) advice = BeanConfig::Advice::FINER;
        else if (strcmp(verdict, "coarser") == 0) advice = BeanConfig::Advice::COARSER;
        else if (strcmp(verdict, "ok") == 0) advice = BeanConfig::Advice::OK;
        bean_config.set_advice(advice);
    }

    // Bag level: {"bag":{...,"shots_remaining":N,"low":bool}}. shots_remaining
    // is null when no bag size is set (json_find_number fails) -> unknown.
    double shots = 0.0;
    if (json_find_number(response, "shots_remaining", &shots)) {
        bean_config.set_bag_status((int16_t)shots, strstr(response, "\"low\":true") != nullptr);
    } else {
        bean_config.set_bag_status(-1, false);
    }
}

// Uploads one queued brew record per step. The response's per-record status
// decides the file's fate: 'stored' and 'deleted' drop it, 'unknown' (the
// session hasn't uploaded yet) keeps it for the next window. Failures are
// logged and skipped - brews never fail a run that stored sessions.
CloudSync::StepResult CloudSync::step_brew_upload() {
    BrewRecord record;
    if (!brew_log.read_next(brew_cursor, &record)) {
        run_phase = config_refreshed ? RunPhase::SNAPSHOT : RunPhase::CONFIG_FETCH;
        return StepResult::RUNNING;
    }
    brew_cursor = record.session_id;

    char body[192];
    size_t len = snprintf(body, sizeof(body),
        "{\"brews\":[{\"session_id\":%lu,\"session_timestamp\":%lu,"
        "\"brew_output_g\":%.1f,\"brew_time_s\":%u}]}",
        (unsigned long)record.session_id,
        (unsigned long)record.session_timestamp,
        record.output_g,
        (unsigned)record.brew_time_s);

    char response[CLOUD_SYNC_RESPONSE_BUFFER_BYTES > 1024 ? 1024 : CLOUD_SYNC_RESPONSE_BUFFER_BYTES];
    int status = http_request("POST", "/brews", "application/json",
                              (const uint8_t*)body, len, response, sizeof(response));
    if (status != 200) {
        LOG_BLE("[CLOUD] Brew upload for session %lu failed (HTTP %d)\n",
                (unsigned long)record.session_id, status);
        // Old servers (404) or a flaky link: leave the queue alone, move on.
        return StepResult::RUNNING;
    }

    if (strstr(response, "\"status\":\"stored\"") || strstr(response, "\"status\":\"deleted\"")) {
        brew_log.remove(record.session_id);
    }
    apply_device_config(response);
    return StepResult::RUNNING;
}

// Fetches {active bean, advice} when no brew upload already delivered it.
// Best-effort like the snapshot: an old server without the endpoint must not
// fail the run.
CloudSync::StepResult CloudSync::step_config_fetch() {
    char response[CLOUD_SYNC_RESPONSE_BUFFER_BYTES > 1024 ? 1024 : CLOUD_SYNC_RESPONSE_BUFFER_BYTES];
    int status = http_request("GET", "/config", nullptr, nullptr, 0,
                              response, sizeof(response));
    if (status == 200) {
        apply_device_config(response);
    } else {
        LOG_BLE("[CLOUD] Config fetch failed (HTTP %d)\n", status);
    }
    run_phase = RunPhase::SNAPSHOT;
    return StepResult::RUNNING;
}

// Posts the compact health observation that turns Device Health into a
// history server-side (docs/CLOUD_SYNC.md "Health snapshots ride along").
CloudSync::StepResult CloudSync::step_snapshot() {
    char body[768];
    size_t len = snprintf(body, sizeof(body),
        "{"
        "\"source\":\"device\","
        "\"firmware_version\":\"%s\","
        "\"build\":%d,"
        "\"device_id\":\"%s\","
        "\"uptime_min\":%lu,"
        "\"heap_free\":%u,"
        "\"sessions_on_flash\":%lu,"
        "\"time_synced\":%s,"
        "\"lifetime\":{"
        "\"total_grinds\":%lu,"
        "\"weight_mode_grinds\":%lu,"
        "\"time_mode_grinds\":%lu,"
        "\"motor_runtime_sec\":%lu,"
        "\"total_weight_kg\":%.3f,"
        "\"avg_accuracy_g\":%.3f,"
        "\"total_pulses\":%lu,"
        "\"uptime_hrs\":%lu"
        "}"
        "}",
        BUILD_FIRMWARE_VERSION,
        BUILD_NUMBER,
        device_id(),
        (unsigned long)(millis() / 60000UL),
        (unsigned int)ESP.getFreeHeap(),
        (unsigned long)grind_logger.get_total_flash_sessions(),
        TimeSync::is_synced() ? "true" : "false",
        (unsigned long)statistics_manager.get_total_grinds(),
        (unsigned long)statistics_manager.get_weight_mode_grinds(),
        (unsigned long)statistics_manager.get_time_mode_grinds(),
        (unsigned long)statistics_manager.get_motor_runtime_sec(),
        statistics_manager.get_total_weight_kg(),
        statistics_manager.get_avg_accuracy_g(),
        (unsigned long)statistics_manager.get_total_pulses(),
        (unsigned long)statistics_manager.get_device_uptime_hrs());

    int status = http_request("POST", "/snapshots", "application/json",
                              (const uint8_t*)body, len, nullptr, 0);
    if (status != 201) {
        LOG_BLE("[CLOUD] Snapshot upload failed (HTTP %d)\n", status);
        // Sessions made it; a lost observation is not worth failing the run.
    }
    return StepResult::DONE;
}

// ---- HTTP ------------------------------------------------------------------

int CloudSync::http_request(const char* method, const char* path,
                            const char* content_type,
                            const uint8_t* body, size_t body_len,
                            char* response, size_t response_cap) {
    char url[sizeof(server_url) + sizeof(store_id) + 48];
    snprintf(url, sizeof(url), "%s/api/stores/%s%s", server_url, store_id, path);

    esp_http_client_config_t config = {};
    config.url = url;
    config.timeout_ms = CLOUD_SYNC_HTTP_TIMEOUT_MS;
#ifdef CLOUD_SYNC_HAS_CRT_BUNDLE
    // Validates public CAs (Let's Encrypt, Vercel, ...) with zero
    // provisioning. Self-hosted plain http:// URLs skip TLS entirely.
    config.crt_bundle_attach = esp_crt_bundle_attach;
#endif

    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (!client) return -1;

    esp_http_client_set_method(client,
        strcmp(method, "POST") == 0 ? HTTP_METHOD_POST : HTTP_METHOD_GET);

    char auth[sizeof(upload_key) + 8];
    snprintf(auth, sizeof(auth), "Bearer %s", upload_key);
    esp_http_client_set_header(client, "Authorization", auth);
    esp_http_client_set_header(client, "x-device-id", device_id());
    if (content_type) esp_http_client_set_header(client, "Content-Type", content_type);

    int status = -1;
    esp_err_t err = esp_http_client_open(client, body_len);
    if (err == ESP_OK) {
        if (body_len > 0
            && esp_http_client_write(client, (const char*)body, body_len) != (int)body_len) {
            status = -2;
        } else if (esp_http_client_fetch_headers(client) < 0) {
            status = -3;
        } else {
            status = esp_http_client_get_status_code(client);
            if (response && response_cap > 0) {
                int read = esp_http_client_read_response(client, response, response_cap - 1);
                response[read > 0 ? read : 0] = '\0';
            }
        }
        esp_http_client_close(client);
    } else {
        LOG_BLE("[CLOUD] Connection to %s failed (%d)\n", url, (int)err);
    }
    esp_http_client_cleanup(client);
    return status;
}

// ---- accessors -------------------------------------------------------------

void CloudSync::get_server_url(char* out, size_t len) const { copy_bounded(out, len, server_url); }
void CloudSync::get_store_id(char* out, size_t len) const { copy_bounded(out, len, store_id); }
void CloudSync::get_view_key(char* out, size_t len) const { copy_bounded(out, len, view_key); }

const char* CloudSync::state_name() const {
    switch (state) {
        case State::NOT_CONFIGURED: return "not_configured";
        case State::DISABLED_BY_USER: return "disabled";
        case State::IDLE: return "idle";
        case State::SYNCING: return "syncing";
    }
    return "unknown";
}

const char* CloudSync::run_phase_name(uint8_t phase_id) {
    switch (phase_id) {
        case 0: return "idle";
        case (uint8_t)RunPhase::MANIFEST + 1: return "manifest";
        case (uint8_t)RunPhase::UPLOAD + 1: return "session upload";
        case (uint8_t)RunPhase::BREW_UPLOAD + 1: return "brew upload";
        case (uint8_t)RunPhase::CONFIG_FETCH + 1: return "config fetch";
        case (uint8_t)RunPhase::SNAPSHOT + 1: return "health snapshot";
        default: return "unknown";
    }
}

const char* CloudSync::last_result_name() const {
    switch (last_result) {
        case LastResult::NONE: return "none";
        case LastResult::SUCCESS: return "success";
        case LastResult::PARTIAL: return "partial";
        case LastResult::FAILED: return "failed";
        case LastResult::ABORTED: return "aborted";
    }
    return "unknown";
}
