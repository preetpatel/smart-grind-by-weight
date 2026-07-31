#include "time_sync.h"
#include <cstdlib>
#include <ctime>
#include <sys/time.h>

namespace {
    bool synced = false;
    uint32_t last_sync = 0;
    int16_t ble_tz_offset_min = 0;
    bool tz_rule_active = false;
}

namespace TimeSync {

void set_epoch(uint32_t epoch_utc_seconds, int16_t tz_offset_minutes) {
    struct timeval tv = {};
    tv.tv_sec = static_cast<time_t>(epoch_utc_seconds);
    settimeofday(&tv, nullptr);
    synced = true;
    last_sync = epoch_utc_seconds;
    ble_tz_offset_min = tz_offset_minutes;
}

void mark_synced_from_sntp() {
    synced = true;
    last_sync = static_cast<uint32_t>(time(nullptr));
}

void apply_tz_rule(const char* rule) {
    if (rule && rule[0] != '\0') {
        setenv("TZ", rule, 1);
        tzset();
        tz_rule_active = true;
    } else {
        unsetenv("TZ");
        tzset();
        tz_rule_active = false;
    }
}

bool has_tz_rule() {
    return tz_rule_active;
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
    if (!tz_rule_active) {
        return ble_tz_offset_min;
    }
    // Effective offset under the TZ rule right now (DST-aware): wall-clock
    // difference between the local and UTC breakdowns of the same instant.
    // Real offsets are within +/-14h, so the calendar-day delta is -1/0/+1;
    // a month or year wrap shows up as a large tm_mday jump and clamps.
    time_t now = time(nullptr);
    struct tm local_tm, utc_tm;
    localtime_r(&now, &local_tm);
    gmtime_r(&now, &utc_tm);
    int day_delta = local_tm.tm_mday - utc_tm.tm_mday;
    if (day_delta > 1) day_delta = -1;
    else if (day_delta < -1) day_delta = 1;
    int offset_min = day_delta * 1440 + (local_tm.tm_hour - utc_tm.tm_hour) * 60
                   + (local_tm.tm_min - utc_tm.tm_min);
    return static_cast<int16_t>(offset_min);
}

void format_local_time(char* out, size_t len, const char* fmt) {
    if (!out || len == 0) return;
    out[0] = '\0';
    if (!synced) return;
    struct tm tm_info;
    if (tz_rule_active) {
        time_t now = time(nullptr);
        localtime_r(&now, &tm_info); // C library applies the TZ rule, DST included
    } else {
        time_t local = time(nullptr) + static_cast<time_t>(ble_tz_offset_min) * 60;
        gmtime_r(&local, &tm_info); // offset already applied; format as-is
    }
    strftime(out, len, fmt, &tm_info);
}

}
