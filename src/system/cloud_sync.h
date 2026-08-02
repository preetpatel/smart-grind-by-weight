#pragma once
#include <cstdint>
#include <cstddef>
#include "../config/constants.h"

/**
 * CloudSync - uploads grind sessions to a cloud store (docs/CLOUD_SYNC.md).
 *
 * The second WifiService consumer (after SNTP): whenever a connection window
 * is open, WifiService drives step() once per main-loop pass. Each step does
 * at most one blocking HTTP operation, so grind/OTA/export gating is
 * re-checked between operations and a window can be torn down mid-run.
 *
 * Protocol per run: manifest handshake (one tuple per session file on flash;
 * the server replies with the session ids it lacks) -> one POST per wanted
 * session (verbatim file bytes; server dedups by content hash) -> one small
 * health snapshot POST. Zero sync state is kept on the device: a wiped
 * server just asks for everything again.
 *
 * Cross-task contract (same as WifiService): set_config()/forget_config()/
 * set_enabled() may be called from the bluetooth task (deferred BLE writes)
 * or the UI task. They only touch NVS and set an atomic reload flag; all
 * network calls and cached config strings stay on the main-loop task.
 */
class CloudSync {
public:
    enum class State : uint8_t {
        NOT_CONFIGURED,   // No store provisioned
        DISABLED_BY_USER, // Provisioned but toggled off
        IDLE,             // Waiting for the next WifiService window
        SYNCING           // A run is in progress inside a window
    };

    enum class LastResult : uint8_t {
        NONE,     // No run finished yet this boot
        SUCCESS,  // Manifest + all wanted uploads + snapshot succeeded
        PARTIAL,  // Some sessions uploaded, then an operation failed
        FAILED,   // Run failed before anything was stored
        ABORTED   // Window torn down (grind/OTA/export started)
    };

    enum class StepResult : uint8_t { RUNNING, DONE, FAILED };

    void init();

    // Provisioning (BLE write via flasher). Persists to NVS; sync stays off
    // until a store is explicitly provisioned - no phone-home by default.
    void set_config(const char* url, const char* store_id,
                    const char* upload_key, const char* view_key);
    void forget_config();
    void set_enabled(bool enabled);

    bool is_configured() const { return configured; }
    bool is_enabled() const { return enabled; }
    State get_state() const { return state; }
    LastResult get_last_result() const { return last_result; }

    // WifiService integration (main-loop task only)
    bool wants_window();       // New sessions settled on flash and un-synced
    bool should_run() const;   // Run opportunistically in any open window
    void begin_run();
    StepResult step();         // At most one blocking HTTP op per call
    void abort_run();          // Window torn down mid-run

    // Status for the UI page and the BLE status JSON
    uint32_t get_last_success_epoch() const { return last_success_epoch; }
    uint16_t get_last_run_uploaded() const { return last_run_uploaded; }
    uint16_t get_last_run_wanted() const { return last_run_wanted; }
    bool has_unsynced_sessions() const;  // Read-only; safe from any task

    // Copy accessors (safe to call from other tasks; see WifiService note)
    void get_server_url(char* out, size_t len) const;
    void get_store_id(char* out, size_t len) const;
    // The read-only view key is intentionally readable: a browser claims
    // dashboard access by holding the grinder (docs/CLOUD_SYNC.md "Auth
    // model"). The upload key never leaves the device.
    void get_view_key(char* out, size_t len) const;

    const char* state_name() const;
    const char* last_result_name() const;

private:
    enum class RunPhase : uint8_t { MANIFEST, UPLOAD, SNAPSHOT };

    // Cached config, reloaded from NVS on the main-loop task when dirty
    char server_url[CLOUD_SYNC_MAX_URL_LEN + 1] = "";
    char store_id[CLOUD_SYNC_MAX_STORE_ID_LEN + 1] = "";
    char upload_key[CLOUD_SYNC_MAX_KEY_LEN + 1] = "";
    char view_key[CLOUD_SYNC_MAX_KEY_LEN + 1] = "";
    volatile bool configured = false;
    volatile bool enabled = false;
    volatile bool config_dirty = false;
    bool initialized = false;

    volatile State state = State::NOT_CONFIGURED;
    volatile LastResult last_result = LastResult::NONE;

    // New-session detection (grind-complete trigger without coupling into
    // the grind pipeline): GrindLogger bumps its storage version when
    // session files change; a settle delay keeps the radio clear of
    // post-grind top-up pulses.
    uint32_t last_seen_storage_version = 0;
    uint32_t storage_changed_ms = 0;
    uint32_t last_synced_storage_version = 0;

    uint32_t last_success_epoch = 0;
    uint16_t last_run_uploaded = 0;
    uint16_t last_run_wanted = 0;

    // In-run state
    RunPhase run_phase = RunPhase::MANIFEST;
    uint32_t run_storage_version = 0;
    uint32_t* want_ids = nullptr;   // PSRAM, freed at run end
    uint16_t want_count = 0;
    uint16_t want_index = 0;
    uint16_t run_uploaded = 0;

    void reload_config();
    void update_idle_state();
    void end_run(LastResult result);
    char device_id_hex[13] = "";
    const char* device_id();

    StepResult step_manifest();
    StepResult step_upload();
    StepResult step_snapshot();

    // Performs one HTTP request against <server_url>/api/stores/<store_id><path>.
    // Returns the HTTP status code, or a negative value on transport error.
    // response may be null when the body doesn't matter.
    int http_request(const char* method, const char* path,
                     const char* content_type,
                     const uint8_t* body, size_t body_len,
                     char* response, size_t response_cap);
};

extern CloudSync cloud_sync;
