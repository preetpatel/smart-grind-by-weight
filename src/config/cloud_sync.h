#pragma once

// Cloud sync (docs/CLOUD_SYNC.md): the uploader that runs inside WifiService
// connection windows. All timing/limits for the manifest handshake and
// session uploads live here.

#define CLOUD_SYNC_MAX_URL_LEN 95            // Server base URL (https://host[:port])
#define CLOUD_SYNC_MAX_STORE_ID_LEN 31       // "st_" + 16 hex
#define CLOUD_SYNC_MAX_KEY_LEN 47            // "uk_"/"vk_" + 32 hex

// A freshly-flushed session waits this long before triggering a connection
// window, keeping the radio clear of post-grind settling and top-up pulses.
#define CLOUD_SYNC_SETTLE_MS 15000

#define CLOUD_SYNC_HTTP_TIMEOUT_MS 20000     // Per-request ceiling (TLS handshake + transfer)
#define CLOUD_SYNC_MAX_MANIFEST_ENTRIES 250  // Matches MAX_STORED_SESSIONS_FLASH
#define CLOUD_SYNC_MAX_UPLOADS_PER_RUN 100   // Bound one window's work; the rest go next window
#define CLOUD_SYNC_MANIFEST_ENTRY_BYTES 96   // JSON budget per manifest entry
#define CLOUD_SYNC_RESPONSE_BUFFER_BYTES 4096 // Manifest "want" response ceiling
