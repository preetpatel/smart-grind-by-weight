// Host regression tests for the boot-loop guard decision logic
// (src/system/boot_guard_logic.h). The runtime wrapper only feeds it the
// reset reason, persisted counter, and fallback-slot validity - every
// decision that matters is here.

#include <cstdio>

#include "system/boot_guard_logic.h"

static int failures = 0;

#define CHECK(cond, msg)                                        \
    do {                                                        \
        if (!(cond)) {                                          \
            std::printf("FAIL: %s (%s:%d)\n", msg, __FILE__, __LINE__); \
            failures++;                                         \
        }                                                       \
    } while (0)

static void test_normal_resets_never_count() {
    // Power-on, EXT and software resets clear the counter regardless of its
    // value - rapid power cycling must never trigger a rollback.
    const uint8_t priors[] = {0, 1, 2, 250};
    for (uint8_t prior : priors) {
        auto d = boot_guard_decide(/*crash=*/false, prior, /*fallback=*/true);
        CHECK(d.action == BootGuardAction::CLEAR, "normal reset clears");
        CHECK(d.new_count == 0, "normal reset zeroes counter");
    }
}

static void test_crashes_count_up_to_threshold() {
    auto d1 = boot_guard_decide(true, 0, true);
    CHECK(d1.action == BootGuardAction::COUNT && d1.new_count == 1, "first crash counts to 1");

    auto d2 = boot_guard_decide(true, 1, true);
    CHECK(d2.action == BootGuardAction::COUNT && d2.new_count == 2, "second crash counts to 2");
}

static void test_third_crash_rolls_back() {
    auto d = boot_guard_decide(true, 2, true);
    CHECK(d.action == BootGuardAction::ROLLBACK, "third crash rolls back");
    CHECK(d.new_count == 0, "rollback resets counter for the fallback image");
}

static void test_no_fallback_gives_up() {
    // Fresh USB install: the other OTA slot is erased. The guard must clear
    // and keep retrying the only firmware present, not wedge at threshold.
    auto d = boot_guard_decide(true, 2, false);
    CHECK(d.action == BootGuardAction::GIVE_UP, "no fallback gives up");
    CHECK(d.new_count == 0, "give-up clears counter");
}

static void test_recovery_after_intermittent_crash() {
    // Crash, then a healthy power cycle: counter resets, so a later isolated
    // crash starts counting from scratch.
    auto crash = boot_guard_decide(true, 0, true);
    auto healthy = boot_guard_decide(false, crash.new_count, true);
    CHECK(healthy.new_count == 0, "healthy boot resets progress");
    auto later = boot_guard_decide(true, healthy.new_count, true);
    CHECK(later.new_count == 1, "isolated crashes never accumulate");
}

static void test_counter_saturates() {
    auto d = boot_guard_decide(true, 255, false);
    CHECK(d.action == BootGuardAction::GIVE_UP, "saturated counter still resolves");
    // Custom threshold path
    auto d2 = boot_guard_decide(true, 4, true, /*threshold=*/6);
    CHECK(d2.action == BootGuardAction::COUNT && d2.new_count == 5, "custom threshold counts");
    auto d3 = boot_guard_decide(true, 5, true, /*threshold=*/6);
    CHECK(d3.action == BootGuardAction::ROLLBACK, "custom threshold triggers");
}

int main() {
    test_normal_resets_never_count();
    test_crashes_count_up_to_threshold();
    test_third_crash_rolls_back();
    test_no_fallback_gives_up();
    test_recovery_after_intermittent_crash();
    test_counter_saturates();

    if (failures) {
        std::printf("%d check(s) failed\n", failures);
        return 1;
    }
    std::printf("all boot guard checks passed\n");
    return 0;
}
