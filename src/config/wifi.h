#pragma once

//==============================================================================
// WIFI TIME SYNC CONFIGURATION
//==============================================================================
// WiFi is used only as a duty-cycled time source: the radio comes up, SNTP
// sets the clock, and the radio goes back off. Credentials arrive over BLE
// from the web flasher (see BLE_SYSINFO_WIFI_CONFIG_CHAR_UUID) and live in the
// "wifi" NVS namespace. The service never runs while a grind is active so
// radio contention cannot touch the 20ms control loop.
//
// The radio comes up at exactly two moments, neither of which overlaps another
// load on the supply (src/system/sync_schedule_logic.h): once a minute after
// boot to set the clock, and once CLOUD_SYNC_GRIND_DELAY_MS after a grind for
// everything else. There is no periodic sync.

//------------------------------------------------------------------------------
// NTP SERVERS
//------------------------------------------------------------------------------
#define WIFI_NTP_SERVER_1 "pool.ntp.org"
#define WIFI_NTP_SERVER_2 "time.google.com"

//------------------------------------------------------------------------------
// SYNC SCHEDULING
//------------------------------------------------------------------------------
// Long enough that LVGL, PSRAM, the load cell and BLE advertising have all
// finished starting before the radio transmits. The 5s this used to be put the
// association and the uploader's TLS handshake right on top of the startup
// current draw, which is where both of the 2026-08-06/07 brownouts happened.
#define WIFI_BOOT_ATTEMPT_DELAY_MS 60000               // Boot clock sync, once, this long after boot
// Not a scheduler: the clock is refreshed inside a window some other errand
// has already opened, once the last SNTP is this old. Never wakes the radio.
#define WIFI_CLOCK_REFRESH_INTERVAL_MS (24UL * 60 * 60 * 1000)
#define WIFI_CONNECT_TIMEOUT_MS 20000                  // Give up on WiFi association after this
#define WIFI_SNTP_TIMEOUT_MS 15000                     // Give up waiting for the NTP response
#define WIFI_RETRY_BACKOFF_START_MS 60000              // First retry after a failed attempt
#define WIFI_RETRY_BACKOFF_MAX_MS (60UL * 60 * 1000)   // Backoff ceiling (hourly)

//------------------------------------------------------------------------------
// CREDENTIAL / TIMEZONE LIMITS
//------------------------------------------------------------------------------
// SSID and passphrase caps follow the 802.11 limits; the POSIX TZ rule string
// (e.g. "NZST-12NZDT,M9.5.0,M4.1.0/3") and IANA zone name are display/DST
// metadata provisioned alongside the credentials.
#define WIFI_MAX_SSID_LEN 32
#define WIFI_MAX_PASS_LEN 64
#define WIFI_MAX_TZ_RULE_LEN 64
#define WIFI_MAX_TZ_NAME_LEN 48
