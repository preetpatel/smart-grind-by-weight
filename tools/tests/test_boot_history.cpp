// Host regression tests for the boot recorder's pure logic
// (src/system/boot_history_logic.h): the reset-kind classification the
// diagnosis hangs on, the ring that has to survive being read back out of
// NVS, and the black-box checksum that decides whether the previous boot's
// last known state is evidence or debris.

#include <cstdio>
#include <cstring>

#include "system/boot_history_logic.h"

static int failures = 0;

#define CHECK(cond, msg)                                            \
    do {                                                            \
        if (!(cond)) {                                              \
            std::printf("FAIL: %s (%s:%d)\n", msg, __FILE__, __LINE__); \
            failures++;                                             \
        }                                                           \
    } while (0)

static BootRecord make_record(uint32_t epoch, BootResetKind kind) {
    BootRecord record = {};
    record.boot_epoch = epoch;
    record.build = 100501;
    record.kind = (uint8_t)kind;
    return record;
}

static void test_reset_classification() {
    // The distinction the whole feature exists for: a firmware fault and a
    // supply fault must never be lumped together.
    CHECK(boot_reset_is_crash(BootResetKind::PANIC), "panic is a crash");
    CHECK(boot_reset_is_crash(BootResetKind::TASK_WDT), "task wdt is a crash");
    CHECK(boot_reset_is_crash(BootResetKind::INT_WDT), "int wdt is a crash");
    CHECK(boot_reset_is_crash(BootResetKind::OTHER_WDT), "wdt is a crash");
    CHECK(!boot_reset_is_crash(BootResetKind::BROWNOUT), "brownout is not a firmware crash");
    CHECK(!boot_reset_is_crash(BootResetKind::POWER_ON), "power-on is not a crash");
    CHECK(!boot_reset_is_crash(BootResetKind::SOFTWARE), "esp_restart is not a crash");

    CHECK(boot_reset_is_power(BootResetKind::BROWNOUT), "brownout is a power event");
    CHECK(boot_reset_is_power(BootResetKind::POWER_ON), "power-on is a power event");
    CHECK(!boot_reset_is_power(BootResetKind::PANIC), "panic is not a power event");

    CHECK(std::strcmp(boot_reset_kind_name(BootResetKind::BROWNOUT), "BROWNOUT") == 0,
          "brownout names itself");
    CHECK(std::strcmp(boot_reset_kind_name((BootResetKind)200), "UNKNOWN") == 0,
          "out-of-range kind degrades to UNKNOWN");
}

static void test_ring_orders_newest_first() {
    BootRing ring = {};
    boot_ring_push(&ring, make_record(1000, BootResetKind::POWER_ON));
    boot_ring_push(&ring, make_record(2000, BootResetKind::BROWNOUT));
    boot_ring_push(&ring, make_record(3000, BootResetKind::PANIC));

    CHECK(ring.count == 3, "three pushes counted");
    CHECK(boot_ring_at(&ring, 0)->boot_epoch == 3000, "index 0 is newest");
    CHECK(boot_ring_at(&ring, 2)->boot_epoch == 1000, "last index is oldest");
    CHECK(boot_ring_at(&ring, 3) == nullptr, "reading past the count returns null");
    CHECK(boot_ring_newest(&ring)->boot_epoch == 3000, "newest accessor agrees");
}

static void test_ring_wraps_and_drops_oldest() {
    BootRing ring = {};
    for (uint32_t i = 1; i <= BOOT_HISTORY_DEPTH + 3; i++) {
        boot_ring_push(&ring, make_record(i * 1000, BootResetKind::SOFTWARE));
    }

    CHECK(ring.count == BOOT_HISTORY_DEPTH, "count saturates at the depth");
    CHECK(boot_ring_at(&ring, 0)->boot_epoch == (BOOT_HISTORY_DEPTH + 3) * 1000,
          "newest survives the wrap");
    CHECK(boot_ring_at(&ring, BOOT_HISTORY_DEPTH - 1)->boot_epoch == 4000,
          "oldest three were dropped in order");
    CHECK(boot_ring_at(&ring, BOOT_HISTORY_DEPTH) == nullptr, "no phantom entries past depth");
}

static void test_ring_rejects_garbage() {
    // NVS hands back whatever bytes are stored; indices that would run off the
    // array have to read as "no history" rather than out-of-bounds.
    BootRing ring = {};
    ring.count = 200;
    ring.head = 99;
    CHECK(!boot_ring_valid(&ring), "impossible counters are rejected");
    CHECK(boot_ring_at(&ring, 0) == nullptr, "invalid ring reads empty");
    CHECK(boot_ring_newest(&ring) == nullptr, "invalid ring has no newest");

    boot_ring_push(&ring, make_record(1000, BootResetKind::PANIC));
    CHECK(ring.count == 200, "push on an invalid ring is a no-op");
    CHECK(boot_ring_valid(nullptr) == false, "null ring is invalid");
}

static void test_durations_bridge_consecutive_boots() {
    BootRing ring = {};
    boot_ring_push(&ring, make_record(1000, BootResetKind::POWER_ON));
    boot_ring_push(&ring, make_record(1600, BootResetKind::BROWNOUT));

    // The running boot is closed out by the current wall clock.
    CHECK(boot_ring_duration_s(&ring, 0, 1750) == 150, "running boot measured against now");
    // The older boot ended when the newer one started.
    CHECK(boot_ring_duration_s(&ring, 1, 1750) == 600, "previous boot ends where the next begins");
}

static void test_durations_refuse_to_guess() {
    BootRing ring = {};
    boot_ring_push(&ring, make_record(0, BootResetKind::PANIC));      // never got a clock
    boot_ring_push(&ring, make_record(5000, BootResetKind::BROWNOUT));

    CHECK(boot_ring_duration_s(&ring, 1, 6000) == 0, "unstamped boot reports no duration");
    CHECK(boot_ring_duration_s(&ring, 0, 0) == 0, "unknown now reports no duration");

    // An SNTP correction can move a later boot's stamp behind an earlier one;
    // a negative interval must read as unknown, not wrap around.
    BootRing skewed = {};
    boot_ring_push(&skewed, make_record(9000, BootResetKind::SOFTWARE));
    boot_ring_push(&skewed, make_record(1000, BootResetKind::PANIC));
    CHECK(boot_ring_duration_s(&skewed, 1, 2000) == 0, "backwards clock reports no duration");
}

static void test_black_box_accepts_a_written_record() {
    BootBlackBox box = {};
    box.magic = BOOT_BLACKBOX_MAGIC;
    box.build = 100501;
    box.uptime_ms = 94000;
    box.free_internal = 9224;
    box.min_free_internal = 8468;
    box.ui_state = 4;
    box.grind_phase = 0;
    box.sync_phase = 2;
    box.checksum = boot_blackbox_checksum(box);

    CHECK(boot_blackbox_valid(box), "a freshly checksummed box reads back");
}

static void test_black_box_rejects_debris() {
    // Uninitialised RTC RAM after a power-on, and a half-written or corrupted
    // record, both have to be refused - reporting debris as "last known state"
    // is worse than reporting nothing.
    BootBlackBox blank = {};
    CHECK(!boot_blackbox_valid(blank), "zeroed RTC RAM is not a record");

    BootBlackBox noise = {};
    std::memset(&noise, 0xA5, sizeof(noise));
    CHECK(!boot_blackbox_valid(noise), "garbage RTC RAM is not a record");

    BootBlackBox torn = {};
    torn.magic = BOOT_BLACKBOX_MAGIC;
    torn.uptime_ms = 1000;
    torn.checksum = boot_blackbox_checksum(torn);
    torn.uptime_ms = 2000;  // updated without re-checksumming
    CHECK(!boot_blackbox_valid(torn), "a torn update fails the checksum");

    BootBlackBox wrong_magic = {};
    wrong_magic.magic = 0xDEADBEEF;
    wrong_magic.checksum = boot_blackbox_checksum(wrong_magic);
    CHECK(!boot_blackbox_valid(wrong_magic), "a stale layout fails the magic");
}

int main() {
    test_reset_classification();
    test_ring_orders_newest_first();
    test_ring_wraps_and_drops_oldest();
    test_ring_rejects_garbage();
    test_durations_bridge_consecutive_boots();
    test_durations_refuse_to_guess();
    test_black_box_accepts_a_written_record();
    test_black_box_rejects_debris();

    if (failures) {
        std::printf("%d check(s) failed\n", failures);
        return 1;
    }
    std::printf("all boot history checks passed\n");
    return 0;
}
