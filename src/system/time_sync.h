#pragma once
#include <cstddef>
#include <cstdint>

// Wall-clock synchronisation over BLE. The board has no battery-backed RTC, so
// the system clock is only trustworthy after a client (web flasher or Python
// tool) writes the current epoch on connect. Until then the clock stays
// hidden in the UI and session timestamps fall back to uptime seconds.
//
// Sync payload (little-endian): [epoch_utc_seconds:u32][tz_offset_minutes:i16]
// The timezone offset is only used for on-device display; everything stored or
// exported stays in UTC epoch seconds.
namespace TimeSync {
    void set_epoch(uint32_t epoch_utc_seconds, int16_t tz_offset_minutes);
    bool is_synced();
    uint32_t now_epoch();        // Current UTC epoch seconds, 0 if never synced
    uint32_t last_sync_epoch();  // Epoch written at the most recent sync, 0 if never
    int16_t tz_offset_minutes(); // Client-supplied local-time offset for display

    // Formats the current local time (UTC + offset) with strftime. Writes an
    // empty string when the clock has never been synced.
    void format_local_time(char* out, size_t len, const char* fmt);
}
