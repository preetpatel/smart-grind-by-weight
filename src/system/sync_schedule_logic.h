#pragma once

#include <stdint.h>

// Pure scheduling logic behind WifiService and CloudSync, kept free of
// ESP-IDF/Arduino dependencies so the host regression tests can exercise every
// case (tools/tests/test_sync_schedule.cpp). The runtime wrappers supply
// millis(), the radio and the uploader.
//
// The rule these functions encode: the radio only ever comes up at two moments,
// and neither of them overlaps something else drawing current. Once at boot to
// set the clock, and once a while after a grind to do everything else. Nothing
// is on a periodic timer. Diagnosed from the boot ring on 2026-08-07 - two
// brownouts, both inside the boot window, both with the uploader's TLS
// handshake in flight 8-11 s in while the rest of the board was still starting.

// Why a connection window was opened. The boot window exists only to set the
// clock; the uploader rides the window a finished grind brings up later.
enum class SyncWindowPurpose : uint8_t {
    CLOCK_ONLY,
    CLOUD_SYNC,
};

// millis() rollover-safe "has this deadline passed?".
inline bool sync_deadline_passed(uint32_t now, uint32_t deadline) {
    return (int32_t)(now - deadline) >= 0;
}

struct SyncWindowDecision {
    bool due;
    SyncWindowPurpose purpose;
};

// A window is due when a scheduled attempt comes round (boot, or a retry after
// a failure), the user asked for one by provisioning, or the uploader has work
// that has been sitting long enough. `attempt_scheduled` is what keeps a
// satisfied boot sync from re-firing forever: on success nothing is rescheduled
// and the stale deadline must not count as due. A retry that has not come due
// yet is a promise to stay off the air until its deadline: cloud work waits
// for it and upgrades it, rather than reopening the window on the very next
// loop pass while the router is away. Only a user request jumps the backoff.
inline SyncWindowDecision sync_window_due(uint32_t now, bool attempt_scheduled,
                                          uint32_t next_attempt_ms,
                                          SyncWindowPurpose scheduled_purpose,
                                          bool user_requested, bool cloud_wants) {
    bool scheduled_due = attempt_scheduled && sync_deadline_passed(now, next_attempt_ms);
    bool retry_pending = attempt_scheduled && !scheduled_due;
    if (user_requested) return {true, SyncWindowPurpose::CLOUD_SYNC};
    if (retry_pending) return {false, scheduled_purpose};
    // Cloud work is the broader errand: if the uploader wants this window, run
    // it as a cloud window even when a clock retry is what came due.
    if (cloud_wants) return {true, SyncWindowPurpose::CLOUD_SYNC};
    if (scheduled_due) return {true, scheduled_purpose};
    return {false, SyncWindowPurpose::CLOCK_ONLY};
}

// What an attempt that ended without success still owes the schedule. Retries
// only ever owe the clock: the uploader re-asks through its own quiet delay
// (wants_window()), so a retry can never put the TLS handshake on air on a
// deadline the grinder's activity had no say in. An aborted cloud window owes
// nothing at all - the grind that tore it down restarts the quiet delay, and
// a stale clock rides the window that delay eventually opens. An aborted
// clock errand (the boot sync) is still owed, since nothing else re-asks
// for it.
struct SyncRetryDecision {
    bool reschedule;
    SyncWindowPurpose purpose;
};

inline SyncRetryDecision sync_retry_after(SyncWindowPurpose window_purpose, bool aborted) {
    if (aborted && window_purpose == SyncWindowPurpose::CLOUD_SYNC) {
        return {false, SyncWindowPurpose::CLOCK_ONLY};
    }
    return {true, SyncWindowPurpose::CLOCK_ONLY};
}

// The clock is refreshed inside a window that is already open, never by waking
// the radio on its own. Stale means "this boot has never had SNTP" or "the last
// one was over a day ago" - the crystal drifts seconds a day, which only shows
// up on the uptimes this grinder actually reaches between resets.
inline bool sync_clock_is_stale(uint32_t now, bool have_sntp, uint32_t last_sntp_ms,
                                uint32_t refresh_interval_ms) {
    if (!have_sntp) return true;
    return (uint32_t)(now - last_sntp_ms) >= refresh_interval_ms;
}

// Whether SNTP is worth waiting for in this window. A cloud window with a fresh
// clock skips it rather than spending the SNTP timeout on air for nothing.
inline bool sync_window_needs_sntp(SyncWindowPurpose purpose, bool clock_stale) {
    return purpose == SyncWindowPurpose::CLOCK_ONLY || clock_stale;
}

// A grind brings the next window forward, but only once the grinder has been
// quiet for the whole delay: top-up pulses, the brew-entry prompt and the shot
// itself all finish well inside it, so the radio never transmits while the
// motor is running or about to.
inline bool sync_grind_window_due(uint32_t now, uint32_t last_activity_ms,
                                  uint32_t delay_ms) {
    return (uint32_t)(now - last_activity_ms) >= delay_ms;
}
