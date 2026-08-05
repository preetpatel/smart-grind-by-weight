#include "boot_history.h"

#include <Arduino.h>
#include <Preferences.h>
#include <cstring>
#include <esp_attr.h>
#include <esp_heap_caps.h>
#include <esp_system.h>

#include "../config/constants.h"
#include "time_sync.h"

namespace {

constexpr const char* kNamespace = "bootlog";
constexpr const char* kRingKey = "ring";

// Heap probes walk the region lists, so they run on a slower cadence than the
// 10ms main loop. Anything that dies between samples still reports a free
// figure from within half a second of the fault.
constexpr uint32_t kHeapSampleIntervalMs = 500;

// Survives every reset except a power-on: this is the whole point of the
// black box, and why it is NOINIT rather than plain RTC data.
RTC_NOINIT_ATTR BootBlackBox live_box;

BootBlackBox recovered_box;
bool have_recovered = false;

BootRing boot_ring;
BootResetKind boot_kind = BootResetKind::UNKNOWN;
bool epoch_stamped = false;
uint32_t last_heap_sample_ms = 0;

BootResetKind map_reset_reason(esp_reset_reason_t reason) {
    switch (reason) {
        case ESP_RST_POWERON:   return BootResetKind::POWER_ON;
        case ESP_RST_EXT:       return BootResetKind::EXTERNAL_PIN;
        case ESP_RST_SW:        return BootResetKind::SOFTWARE;
        case ESP_RST_PANIC:     return BootResetKind::PANIC;
        case ESP_RST_TASK_WDT:  return BootResetKind::TASK_WDT;
        case ESP_RST_INT_WDT:   return BootResetKind::INT_WDT;
        case ESP_RST_WDT:       return BootResetKind::OTHER_WDT;
        case ESP_RST_BROWNOUT:  return BootResetKind::BROWNOUT;
        case ESP_RST_DEEPSLEEP: return BootResetKind::DEEP_SLEEP;
        case ESP_RST_SDIO:      return BootResetKind::SDIO;
        default:                return BootResetKind::UNKNOWN;
    }
}

void reset_live_box() {
    std::memset(&live_box, 0, sizeof(live_box));
    live_box.magic = BOOT_BLACKBOX_MAGIC;
    live_box.build = BUILD_NUMBER;
    live_box.checksum = boot_blackbox_checksum(live_box);
}

void persist_ring() {
    Preferences prefs;
    if (!prefs.begin(kNamespace, false)) return;
    prefs.putBytes(kRingKey, &boot_ring, sizeof(boot_ring));
    prefs.end();
}

// The start of this boot is only knowable once something hands the device a
// wall clock, which is seconds to minutes after the fact. Stamping it late
// keeps the reset kind itself recorded immediately, where a crash five
// seconds in cannot lose it.
void stamp_epoch_if_due() {
    if (epoch_stamped || !TimeSync::is_synced()) return;

    uint32_t now_epoch = TimeSync::now_epoch();
    if (now_epoch == 0) return;

    epoch_stamped = true;
    BootRecord* newest = boot_ring_newest(&boot_ring);
    if (!newest) return;

    newest->boot_epoch = now_epoch - (millis() / 1000);
    persist_ring();
}

}  // namespace

namespace BootHistory {

void init() {
    boot_kind = map_reset_reason(esp_reset_reason());

    // Read the black box before the running copy overwrites it.
    if (boot_blackbox_valid(live_box)) {
        recovered_box = live_box;
        have_recovered = true;
    }
    reset_live_box();

    Preferences prefs;
    if (prefs.begin(kNamespace, false)) {
        size_t stored = prefs.getBytesLength(kRingKey);
        if (stored != sizeof(boot_ring) ||
            prefs.getBytes(kRingKey, &boot_ring, sizeof(boot_ring)) != sizeof(boot_ring) ||
            !boot_ring_valid(&boot_ring)) {
            std::memset(&boot_ring, 0, sizeof(boot_ring));
        }
        prefs.end();
    } else {
        std::memset(&boot_ring, 0, sizeof(boot_ring));
    }

    BootRecord record = {};
    record.build = BUILD_NUMBER;
    record.kind = (uint8_t)boot_kind;
    boot_ring_push(&boot_ring, record);
    persist_ring();

    LOG_BLE("[BOOT_HISTORY] Reset reason: %s\n", boot_reset_kind_name(boot_kind));
    if (have_recovered) {
        LOG_BLE("[BOOT_HISTORY] Previous boot died after %lus - ui %u, grind phase %u, sync phase %u, %lu B internal free\n",
                (unsigned long)(recovered_box.uptime_ms / 1000),
                (unsigned)recovered_box.ui_state,
                (unsigned)recovered_box.grind_phase,
                (unsigned)recovered_box.sync_phase,
                (unsigned long)recovered_box.free_internal);
    }
}

void note_activity(uint8_t ui_state, uint8_t grind_phase, uint8_t sync_phase) {
    uint32_t now = millis();
    live_box.uptime_ms = now;
    live_box.ui_state = ui_state;
    live_box.grind_phase = grind_phase;
    live_box.sync_phase = sync_phase;

    if (last_heap_sample_ms == 0 || (now - last_heap_sample_ms) >= kHeapSampleIntervalMs) {
        last_heap_sample_ms = now;
        live_box.free_internal = (uint32_t)heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
        live_box.min_free_internal = (uint32_t)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL);
    }

    live_box.checksum = boot_blackbox_checksum(live_box);

    stamp_epoch_if_due();
}

BootResetKind this_boot_kind() {
    return boot_kind;
}

const BootRing* ring() {
    return &boot_ring;
}

const BootBlackBox* previous_black_box() {
    return have_recovered ? &recovered_box : nullptr;
}

}  // namespace BootHistory
