// Host regression tests for the restore decision behind the persisted shot
// log (src/system/brew_prompt.h). Getting this wrong is visible in opposite
// ways: too strict and a brownout mid-shot still loses the yield, too loose
// and the ready screen is buried under a prompt from yesterday's bag.

#include <cstdio>

#include "system/brew_prompt.h"

static int failures = 0;

#define CHECK(cond, msg)                                            \
    do {                                                            \
        if (!(cond)) {                                              \
            std::printf("FAIL: %s (%s:%d)\n", msg, __FILE__, __LINE__); \
            failures++;                                             \
        }                                                           \
    } while (0)

static constexpr uint32_t kWindowS = 900;  // USER_BREW_ENTRY_TIMEOUT_MS / 1000

static void test_nothing_stored_restores_nothing() {
    CHECK(!brew_prompt_should_restore(false, false, true, 1000, 1100, kWindowS),
          "no record means nothing to restore");
    CHECK(!brew_prompt_should_restore(false, true, false, 0, 0, kWindowS),
          "no record wins over every other input");
}

static void test_crash_mid_shot_restores() {
    // The case this exists for: the grinder went down while the shot was being
    // pulled and came back seconds later.
    CHECK(brew_prompt_should_restore(true, false, true, 1000, 1090, kWindowS),
          "a crash 90s into the prompt restores it");
    CHECK(brew_prompt_should_restore(true, false, true, 1000, 1000, kWindowS),
          "no elapsed time restores");
}

static void test_power_on_retires_the_prompt() {
    // Switched off and come back to. Even inside the window, a prompt in front
    // of the ready screen is clutter rather than a rescue.
    CHECK(!brew_prompt_should_restore(true, true, true, 1000, 1010, kWindowS),
          "a clean power-on discards a fresh prompt");
    CHECK(!brew_prompt_should_restore(true, true, false, 0, 0, kWindowS),
          "a clean power-on discards an unaged prompt too");
}

static void test_window_expiry() {
    CHECK(brew_prompt_should_restore(true, false, true, 1000, 1000 + kWindowS, kWindowS),
          "exactly at the window still restores");
    CHECK(!brew_prompt_should_restore(true, false, true, 1000, 1001 + kWindowS, kWindowS),
          "one second past the window discards");
    CHECK(!brew_prompt_should_restore(true, false, true, 1000, 100000, kWindowS),
          "a prompt from hours ago discards");
}

static void test_unaged_records_restore() {
    // Boot reaches the restore before SNTP does, so the clock usually cannot
    // answer "how old is this?" yet. Restoring is the safe side: the on-screen
    // 15-minute timeout still expires it.
    CHECK(brew_prompt_should_restore(true, false, false, 1000, 0, kWindowS),
          "an unsynced clock restores rather than discarding");
    CHECK(brew_prompt_should_restore(true, false, true, 0, 5000, kWindowS),
          "a record written before the clock synced restores");

    // A clock corrected backwards (SNTP landing after a BLE client's guess)
    // must not read as a negative age and wrap into a huge one.
    CHECK(brew_prompt_should_restore(true, false, true, 5000, 1000, kWindowS),
          "a backwards clock restores rather than underflowing");
}

int main() {
    test_nothing_stored_restores_nothing();
    test_crash_mid_shot_restores();
    test_power_on_retires_the_prompt();
    test_window_expiry();
    test_unaged_records_restore();

    if (failures) {
        std::printf("%d check(s) failed\n", failures);
        return 1;
    }
    std::printf("all brew prompt checks passed\n");
    return 0;
}
