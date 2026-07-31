#include "time_sync.h"
#include <ctime>
#include <sys/time.h>

namespace {
    bool synced = false;
    uint32_t last_sync = 0;
    int16_t tz_offset_min = 0;
}

namespace TimeSync {

void set_epoch(uint32_t epoch_utc_seconds, int16_t tz_offset_minutes) {
    struct timeval tv = {};
    tv.tv_sec = static_cast<time_t>(epoch_utc_seconds);
    settimeofday(&tv, nullptr);
    synced = true;
    last_sync = epoch_utc_seconds;
    tz_offset_min = tz_offset_minutes;
}

bool is_synced() {
    return synced;
}

uint32_t now_epoch() {
    if (!synced) return 0;
    return static_cast<uint32_t>(time(nullptr));
}

uint32_t last_sync_epoch() {
    return last_sync;
}

int16_t tz_offset_minutes() {
    return tz_offset_min;
}

void format_local_time(char* out, size_t len, const char* fmt) {
    if (!out || len == 0) return;
    out[0] = '\0';
    if (!synced) return;
    time_t local = time(nullptr) + static_cast<time_t>(tz_offset_min) * 60;
    struct tm tm_info;
    gmtime_r(&local, &tm_info); // offset already applied; format as-is
    strftime(out, len, fmt, &tm_info);
}

}
