// Host regression tests for the WiFi/cloud scheduling logic
// (src/system/sync_schedule_logic.h). The property under test is the one the
// 2026-08-07 brownout diagnosis turned into a rule: the radio comes up at
// exactly two moments - once at boot for the clock, once well after a grind
// for everything else - and never on a periodic timer.

#include <cstdio>
#include <initializer_list>

#include "system/sync_schedule_logic.h"

static int failures = 0;

#define CHECK(cond, msg)                                                \
    do {                                                                \
        if (!(cond)) {                                                  \
            std::printf("FAIL: %s (%s:%d)\n", msg, __FILE__, __LINE__); \
            failures++;                                                 \
        }                                                               \
    } while (0)

static constexpr uint32_t kBootDelay = 60000;
static constexpr uint32_t kGrindDelay = 30UL * 60 * 1000;
static constexpr uint32_t kClockRefresh = 24UL * 60 * 60 * 1000;

static void test_boot_window_is_clock_only() {
    // Nothing is due before the boot delay elapses.
    SyncWindowDecision early = sync_window_due(kBootDelay - 1, true, kBootDelay,
                                               SyncWindowPurpose::CLOCK_ONLY, false, false);
    CHECK(!early.due, "no window before the boot delay");

    SyncWindowDecision boot = sync_window_due(kBootDelay, true, kBootDelay,
                                              SyncWindowPurpose::CLOCK_ONLY, false, false);
    CHECK(boot.due, "boot window opens on its deadline");
    CHECK(boot.purpose == SyncWindowPurpose::CLOCK_ONLY,
          "boot window never carries the uploader");
}

static void test_nothing_is_periodic() {
    // The whole point: once the boot sync succeeds, attempt_scheduled goes
    // false and the stale deadline must never re-fire. This is what a daily
    // WIFI_SYNC_INTERVAL_MS used to do, and what now must not happen.
    for (uint32_t now : {kBootDelay + 1, kBootDelay + kClockRefresh, 0xF0000000u}) {
        SyncWindowDecision decision = sync_window_due(now, false, kBootDelay,
                                                      SyncWindowPurpose::CLOCK_ONLY, false, false);
        CHECK(!decision.due, "a satisfied window never re-fires on its own");
    }
}

static void test_cloud_work_opens_a_cloud_window() {
    SyncWindowDecision cloud = sync_window_due(500000, false, 0,
                                               SyncWindowPurpose::CLOCK_ONLY, false, true);
    CHECK(cloud.due, "the uploader can open a window");
    CHECK(cloud.purpose == SyncWindowPurpose::CLOUD_SYNC, "and it is a cloud window");

    // Provisioning is a deliberate user action, not a background wake-up.
    SyncWindowDecision user = sync_window_due(500000, false, 0,
                                              SyncWindowPurpose::CLOCK_ONLY, true, false);
    CHECK(user.due, "provisioning opens a window");
    CHECK(user.purpose == SyncWindowPurpose::CLOUD_SYNC, "provisioning syncs everything");
}

static void test_cloud_work_upgrades_a_pending_clock_retry() {
    // A failed boot sync leaves a CLOCK_ONLY retry pending. If the uploader
    // also wants the window by the time it comes round, it must not be spent
    // on the clock alone and leave the sessions for another radio wake-up.
    SyncWindowDecision decision = sync_window_due(120000, true, 120000,
                                                  SyncWindowPurpose::CLOCK_ONLY, false, true);
    CHECK(decision.due, "the retry deadline still opens a window");
    CHECK(decision.purpose == SyncWindowPurpose::CLOUD_SYNC,
          "pending cloud work upgrades a clock retry to a cloud window");
}

static void test_backoff_holds_off_cloud_work() {
    // A retry that has not come due is a promise to stay off the air. Cloud
    // work must wait for the deadline (and then upgrade it) rather than
    // reopening the window on the very next loop pass while the router is
    // away - back-to-back association attempts are exactly the sustained
    // draw this schedule exists to avoid.
    SyncWindowDecision held = sync_window_due(90000, true, 120000,
                                              SyncWindowPurpose::CLOCK_ONLY, false, true);
    CHECK(!held.due, "pending cloud work waits for the retry backoff");

    // Provisioning is deliberate; the user watching the panel outranks the
    // backoff.
    SyncWindowDecision user = sync_window_due(90000, true, 120000,
                                              SyncWindowPurpose::CLOCK_ONLY, true, false);
    CHECK(user.due, "a user request jumps a pending retry");
    CHECK(user.purpose == SyncWindowPurpose::CLOUD_SYNC, "and syncs everything");
}

static void test_retries_only_owe_the_clock() {
    // A failed cloud attempt schedules a clock retry, never a cloud one: the
    // uploader re-asks through its own quiet delay, so a retry deadline can
    // never put the TLS handshake on air regardless of grinder activity.
    SyncRetryDecision failed_cloud = sync_retry_after(SyncWindowPurpose::CLOUD_SYNC, false);
    CHECK(failed_cloud.reschedule, "a failed cloud attempt still retries");
    CHECK(failed_cloud.purpose == SyncWindowPurpose::CLOCK_ONLY,
          "but the retry never re-arms the uploader by itself");

    // A cloud window torn down by a grind owes nothing: wants_window()
    // re-asks once the restarted quiet delay elapses. This is the hole that
    // used to bring the uploader back sixty seconds after the grind that
    // aborted it, mid-morning, motor still warm.
    SyncRetryDecision aborted_cloud = sync_retry_after(SyncWindowPurpose::CLOUD_SYNC, true);
    CHECK(!aborted_cloud.reschedule, "an aborted cloud window schedules no retry");

    // The boot clock sync has no other way back; an aborted or failed clock
    // errand stays owed.
    SyncRetryDecision aborted_clock = sync_retry_after(SyncWindowPurpose::CLOCK_ONLY, true);
    CHECK(aborted_clock.reschedule, "an aborted clock sync is still owed");
    CHECK(aborted_clock.purpose == SyncWindowPurpose::CLOCK_ONLY, "as a clock window");
    SyncRetryDecision failed_clock = sync_retry_after(SyncWindowPurpose::CLOCK_ONLY, false);
    CHECK(failed_clock.reschedule, "a failed clock sync retries");
    CHECK(failed_clock.purpose == SyncWindowPurpose::CLOCK_ONLY, "as a clock window");
}

static void test_grind_window_waits_out_the_delay() {
    const uint32_t ground_at = 1000000;
    CHECK(!sync_grind_window_due(ground_at, ground_at, kGrindDelay),
          "no window the instant a grind finishes");
    CHECK(!sync_grind_window_due(ground_at + kGrindDelay - 1, ground_at, kGrindDelay),
          "no window one tick early");
    CHECK(sync_grind_window_due(ground_at + kGrindDelay, ground_at, kGrindDelay),
          "window opens once the grinder has been quiet for the delay");

    // millis() wraps every ~49.7 days; a grind either side of the wrap must
    // still measure as a short interval, not as an instantly-elapsed one.
    const uint32_t before_wrap = 0xFFFFFF00u;
    CHECK(!sync_grind_window_due(0x00000100u, before_wrap, kGrindDelay),
          "a grind across the millis() wrap does not open a window early");
    CHECK(sync_grind_window_due(before_wrap + kGrindDelay, before_wrap, kGrindDelay),
          "and still opens one on time across the wrap");
}

static void test_clock_refresh_rides_an_open_window() {
    CHECK(sync_clock_is_stale(0, false, 0, kClockRefresh),
          "a boot that has never had SNTP is stale");
    CHECK(!sync_clock_is_stale(kClockRefresh - 1, true, 0, kClockRefresh),
          "a clock synced within the day is fresh");
    CHECK(sync_clock_is_stale(kClockRefresh, true, 0, kClockRefresh),
          "a clock older than the refresh interval is stale");

    // A clock window always syncs; a cloud window only bothers when stale,
    // rather than spending the SNTP timeout on air to re-learn the same time.
    CHECK(sync_window_needs_sntp(SyncWindowPurpose::CLOCK_ONLY, false),
          "the boot window syncs even with a fresh clock");
    CHECK(!sync_window_needs_sntp(SyncWindowPurpose::CLOUD_SYNC, false),
          "a cloud window skips SNTP when the clock is fresh");
    CHECK(sync_window_needs_sntp(SyncWindowPurpose::CLOUD_SYNC, true),
          "a cloud window refreshes a stale clock in the window it already has");
}

static void test_deadline_comparison_survives_rollover() {
    const uint32_t deadline = 0x00000100u;  // just after a wrap
    CHECK(!sync_deadline_passed(0xFFFFFF00u, deadline), "deadline past the wrap has not passed");
    CHECK(sync_deadline_passed(deadline, deadline), "deadline passes on the tick itself");
    CHECK(sync_deadline_passed(deadline + 1, deadline), "and after it");
}

int main() {
    test_boot_window_is_clock_only();
    test_nothing_is_periodic();
    test_cloud_work_opens_a_cloud_window();
    test_cloud_work_upgrades_a_pending_clock_retry();
    test_backoff_holds_off_cloud_work();
    test_retries_only_owe_the_clock();
    test_grind_window_waits_out_the_delay();
    test_clock_refresh_rides_an_open_window();
    test_deadline_comparison_survives_rollover();

    if (failures) {
        std::printf("%d check(s) failed\n", failures);
        return 1;
    }
    std::printf("all sync schedule checks passed\n");
    return 0;
}
