#include "time_sync.h"
#include <Preferences.h>
#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <sys/time.h>

namespace {
    bool synced = false;
    uint32_t last_sync = 0;
    int16_t ble_tz_offset_min = 0;
    bool tz_rule_active = false;
    bool clock_24h = false;

    constexpr const char* kPrefsNamespace = "clock";
    constexpr const char* kPrefsKey24h = "use_24h";

    // Breaks the current instant down into local wall-clock fields, honouring
    // whichever offset source is active. False when the clock has never synced.
    bool local_time_fields(struct tm& out) {
        if (!synced) return false;
        if (tz_rule_active) {
            time_t now = time(nullptr);
            localtime_r(&now, &out); // C library applies the TZ rule, DST included
        } else {
            time_t local = time(nullptr) + static_cast<time_t>(ble_tz_offset_min) * 60;
            gmtime_r(&local, &out); // offset already applied; format as-is
        }
        return true;
    }
}

namespace TimeSync {

void init() {
    Preferences prefs;
    prefs.begin(kPrefsNamespace, true);
    clock_24h = prefs.getBool(kPrefsKey24h, false);
    prefs.end();
}

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

void set_use_24h(bool use_24h) {
    clock_24h = use_24h;

    Preferences prefs;
    prefs.begin(kPrefsNamespace, false);
    prefs.putBool(kPrefsKey24h, use_24h);
    prefs.end();
}

bool use_24h() {
    return clock_24h;
}

void format_local_time(char* out, size_t len, const char* fmt) {
    if (!out || len == 0) return;
    out[0] = '\0';
    struct tm tm_info;
    if (!local_time_fields(tm_info)) return;
    strftime(out, len, fmt, &tm_info);
}

void format_local_clock(char* out, size_t len, bool include_date) {
    if (!out || len == 0) return;
    out[0] = '\0';
    struct tm tm_info;
    if (!local_time_fields(tm_info)) return;

    char date[12] = "";
    if (include_date) {
        strftime(date, sizeof(date), "%Y-%m-%d ", &tm_info);
    }

    if (clock_24h) {
        snprintf(out, len, "%s%02d:%02d", date, tm_info.tm_hour, tm_info.tm_min);
        return;
    }

    // 12-hour clock without the leading zero - "%I" would pad it and "%l" is a
    // GNU extension, so the hour is derived here instead.
    int hour12 = tm_info.tm_hour % 12;
    if (hour12 == 0) hour12 = 12;
    snprintf(out, len, "%s%d:%02d %s", date, hour12, tm_info.tm_min,
             tm_info.tm_hour < 12 ? "AM" : "PM");
}

}
