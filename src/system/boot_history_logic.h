#pragma once

#include <stdint.h>

// Pure logic behind the boot recorder, kept free of ESP-IDF/Arduino
// dependencies so the host regression tests can exercise every case
// (tools/tests/test_boot_history.cpp). The runtime wrapper in boot_history.h
// supplies the reset reason, the NVS-backed ring and the RTC black box.

#define BOOT_HISTORY_DEPTH 8

// What ended the previous boot. Mapped from esp_reset_reason(); the split
// between "crash" and everything else is what separates a firmware fault from
// a power fault, which is the whole reason this is recorded.
// EXTERNAL_PIN rather than EXTERNAL: Arduino.h carries `#define EXTERNAL 0`
// for analogReference(), which silently rewrites the enumerator and takes
// every member after it down with it.
enum class BootResetKind : uint8_t {
    UNKNOWN = 0,
    POWER_ON,
    EXTERNAL_PIN,
    SOFTWARE,
    PANIC,
    TASK_WDT,
    INT_WDT,
    OTHER_WDT,
    BROWNOUT,
    DEEP_SLEEP,
    SDIO,
};

inline const char* boot_reset_kind_name(BootResetKind kind) {
    switch (kind) {
        case BootResetKind::POWER_ON:     return "POWER_ON";
        case BootResetKind::EXTERNAL_PIN: return "EXT_PIN";
        case BootResetKind::SOFTWARE:   return "SW";
        case BootResetKind::PANIC:      return "PANIC";
        case BootResetKind::TASK_WDT:   return "TASK_WDT";
        case BootResetKind::INT_WDT:    return "INT_WDT";
        case BootResetKind::OTHER_WDT:  return "WDT";
        case BootResetKind::BROWNOUT:   return "BROWNOUT";
        case BootResetKind::DEEP_SLEEP: return "DEEPSLEEP";
        case BootResetKind::SDIO:       return "SDIO";
        case BootResetKind::UNKNOWN:    break;
    }
    return "UNKNOWN";
}

// The firmware ran itself into the ground: an exception or a watchdog. These
// are the ones the boot-loop guard counts (boot_guard_logic.h).
inline bool boot_reset_is_crash(BootResetKind kind) {
    return kind == BootResetKind::PANIC || kind == BootResetKind::TASK_WDT ||
           kind == BootResetKind::INT_WDT || kind == BootResetKind::OTHER_WDT;
}

// The supply, not the firmware. BROWNOUT is the detector firing; POWER_ON on a
// device nobody unplugged means the same thing with the RTC domain lost too.
inline bool boot_reset_is_power(BootResetKind kind) {
    return kind == BootResetKind::BROWNOUT || kind == BootResetKind::POWER_ON;
}

// One boot. boot_epoch is stamped when the clock first syncs during that boot,
// so it stays 0 for a boot that never reached a network or a BLE client -
// which is itself worth seeing in the report.
struct BootRecord {
    uint32_t boot_epoch;
    uint32_t build;
    uint8_t kind;
    uint8_t reserved[3];
};

// Circular buffer, oldest to newest. `head` is where the next push lands.
struct BootRing {
    uint8_t count;
    uint8_t head;
    uint8_t reserved[2];
    BootRecord entries[BOOT_HISTORY_DEPTH];
};

// A ring read back from NVS carries whatever bytes were there. Anything that
// would index out of bounds is treated as no history rather than trusted.
inline bool boot_ring_valid(const BootRing* ring) {
    return ring && ring->count <= BOOT_HISTORY_DEPTH && ring->head < BOOT_HISTORY_DEPTH;
}

inline void boot_ring_push(BootRing* ring, const BootRecord& record) {
    if (!boot_ring_valid(ring)) return;
    ring->entries[ring->head] = record;
    ring->head = (uint8_t)((ring->head + 1) % BOOT_HISTORY_DEPTH);
    if (ring->count < BOOT_HISTORY_DEPTH) ring->count++;
}

// index 0 is the newest boot (the running one, once init() has pushed it).
inline const BootRecord* boot_ring_at(const BootRing* ring, uint8_t index) {
    if (!boot_ring_valid(ring) || index >= ring->count) return nullptr;
    uint8_t slot = (uint8_t)((ring->head + BOOT_HISTORY_DEPTH - 1 - index) % BOOT_HISTORY_DEPTH);
    return &ring->entries[slot];
}

inline BootRecord* boot_ring_newest(BootRing* ring) {
    if (!boot_ring_valid(ring) || ring->count == 0) return nullptr;
    uint8_t slot = (uint8_t)((ring->head + BOOT_HISTORY_DEPTH - 1) % BOOT_HISTORY_DEPTH);
    return &ring->entries[slot];
}

// How long the boot at `index` lasted: the next-newer boot's start minus its
// own, with now_epoch closing out the running one. 0 means "can't say" - one
// of the two ends never got a clock, or the pair disagrees about time order
// (an SNTP correction can move a later boot's stamp behind an earlier one).
inline uint32_t boot_ring_duration_s(const BootRing* ring, uint8_t index, uint32_t now_epoch) {
    const BootRecord* record = boot_ring_at(ring, index);
    if (!record || record->boot_epoch == 0) return 0;

    uint32_t end = now_epoch;
    if (index > 0) {
        const BootRecord* newer = boot_ring_at(ring, (uint8_t)(index - 1));
        end = newer ? newer->boot_epoch : 0;
    }
    if (end == 0 || end < record->boot_epoch) return 0;
    return end - record->boot_epoch;
}

// The crash black box. Lives in RTC_NOINIT memory, which survives panic,
// watchdog and brownout resets, so it costs no flash and can be refreshed
// from the main loop. The checksum is what makes it safe to read back: after a
// true power-on, or a sag deep enough to drop the RTC domain, the same bytes
// are debris and must be rejected rather than reported as a last known state.
#define BOOT_BLACKBOX_MAGIC 0x42425831u  // "BBX1"

struct BootBlackBox {
    uint32_t magic;
    uint32_t build;
    uint32_t uptime_ms;
    uint32_t free_internal;
    uint32_t min_free_internal;
    uint8_t ui_state;
    uint8_t grind_phase;
    uint8_t sync_phase;  // 0 = no cloud sync running, else CloudSync::RunPhase + 1
    uint8_t reserved;
    uint32_t checksum;
};

inline uint32_t boot_blackbox_checksum(const BootBlackBox& box) {
    uint32_t sum = 0x9E3779B9u;
    sum = sum * 31u + box.magic;
    sum = sum * 31u + box.build;
    sum = sum * 31u + box.uptime_ms;
    sum = sum * 31u + box.free_internal;
    sum = sum * 31u + box.min_free_internal;
    sum = sum * 31u + box.ui_state;
    sum = sum * 31u + box.grind_phase;
    sum = sum * 31u + box.sync_phase;
    return sum;
}

inline bool boot_blackbox_valid(const BootBlackBox& box) {
    return box.magic == BOOT_BLACKBOX_MAGIC && box.checksum == boot_blackbox_checksum(box);
}
