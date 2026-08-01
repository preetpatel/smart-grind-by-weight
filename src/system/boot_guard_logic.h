#pragma once

#include <stdint.h>

// Pure decision logic for the boot-loop guard, kept free of ESP-IDF/Arduino
// dependencies so the host regression tests can exercise every transition
// (see tools/tests/test_boot_guard.cpp). The runtime wrapper in boot_guard.h
// supplies the reset reason, NVS-backed counter, and fallback-slot validity.

enum class BootGuardAction : uint8_t {
    CLEAR,     // Normal reset: zero the crash counter (if not already zero)
    COUNT,     // Crash reset below threshold: persist the incremented counter
    ROLLBACK,  // Crash loop and a valid fallback image exists: switch slots
    GIVE_UP,   // Crash loop but nowhere to roll back to: clear and keep trying
};

struct BootGuardDecision {
    BootGuardAction action;
    uint8_t new_count;  // Counter value to persist
};

// A "crash reset" is a panic or watchdog reset - the signature of a firmware
// image that boots and dies. Power-on/EXT/software resets never count, so
// rapid power cycling (wall switches, unplugging mid-boot) can never trigger
// a rollback.
inline BootGuardDecision boot_guard_decide(bool crash_reset,
                                           uint8_t prior_count,
                                           bool fallback_available,
                                           uint8_t threshold = 3) {
    if (!crash_reset) {
        return {BootGuardAction::CLEAR, 0};
    }

    uint8_t count = (prior_count < 255) ? (uint8_t)(prior_count + 1) : 255;
    if (count < threshold) {
        return {BootGuardAction::COUNT, count};
    }

    if (fallback_available) {
        // Counter resets so the fallback image gets its own full allowance.
        return {BootGuardAction::ROLLBACK, 0};
    }

    // No valid image in the other slot (e.g. fresh USB install). Clear the
    // counter rather than rolling over so the device keeps retrying the only
    // firmware it has instead of wedging the counter at the threshold.
    return {BootGuardAction::GIVE_UP, 0};
}
