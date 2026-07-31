#pragma once
#include <cstddef>
#include <cstdint>

// Wall-clock synchronisation. The board has no battery-backed RTC, so the
// system clock is only trustworthy after either a BLE client (web flasher or
// Python tool) writes the current epoch on connect, or the WiFi service pulls
// it over SNTP (see WifiService). Until then the clock stays hidden in the UI
// and session timestamps fall back to uptime seconds.
//
// BLE sync payload (little-endian): [epoch_utc_seconds:u32][tz_offset_minutes:i16]
//
// Local time for display comes from one of two sources, in priority order:
//  1. A POSIX TZ rule (e.g. "NZST-12NZDT,M9.5.0,M4.1.0/3") provisioned with
//     the WiFi credentials. Applied via setenv("TZ")/tzset(), so the C library
//     handles DST transitions autonomously - the displayed hour flips at the
//     right moment with no network or client involved.
//  2. The flat client-supplied offset from the BLE sync payload (legacy
//     fallback for devices never WiFi-provisioned).
// Everything stored or exported stays in UTC epoch seconds either way.
namespace TimeSync {
    void set_epoch(uint32_t epoch_utc_seconds, int16_t tz_offset_minutes);

    // Marks the clock synced after SNTP has already set the system time.
    void mark_synced_from_sntp();

    // Applies a POSIX TZ rule for local-time display (setenv + tzset). Does
    // not persist anything - the WiFi service owns the stored copy. Passing
    // nullptr or "" clears the rule and falls back to the BLE offset.
    void apply_tz_rule(const char* rule);
    bool has_tz_rule();

    bool is_synced();
    uint32_t now_epoch();        // Current UTC epoch seconds, 0 if never synced
    uint32_t last_sync_epoch();  // Epoch recorded at the most recent sync, 0 if never
    int16_t tz_offset_minutes(); // Effective local-time offset (from TZ rule when set)

    // Formats the current local time with strftime. Writes an empty string
    // when the clock has never been synced.
    void format_local_time(char* out, size_t len, const char* fmt);
}
