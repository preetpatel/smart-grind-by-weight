#include "boot_guard.h"
#include "boot_guard_logic.h"

#include <Arduino.h>
#include <Preferences.h>
#include <esp_ota_ops.h>
#include <esp_system.h>

#include "../config/constants.h"

namespace {

constexpr const char* kNamespace = "bootguard";
constexpr const char* kCountKey = "crash_count";
constexpr const char* kRollbackKey = "rollback";
constexpr uint32_t kHealthyUptimeMs = 30000;

// Counter value found at boot; mark_healthy_if_due() only touches NVS when
// this was non-zero, so healthy reboots cost no flash writes.
uint8_t count_at_boot = 0;
bool healthy_marked = false;
char rollback_info[96] = "";

bool fallback_partition_valid(const esp_partition_t* running,
                              const esp_partition_t** out_fallback) {
    const esp_partition_t* other = esp_ota_get_next_update_partition(NULL);
    if (other == NULL || other == running) {
        return false;
    }
    // A partition that was never flashed (fresh USB install leaves the second
    // OTA slot erased) has no readable app descriptor.
    esp_app_desc_t desc;
    if (esp_ota_get_partition_description(other, &desc) != ESP_OK) {
        return false;
    }
    *out_fallback = other;
    return true;
}

}  // namespace

namespace BootGuard {

void check_on_boot() {
    esp_reset_reason_t reason = esp_reset_reason();
    bool crash_reset = (reason == ESP_RST_PANIC || reason == ESP_RST_INT_WDT ||
                        reason == ESP_RST_TASK_WDT || reason == ESP_RST_WDT);

    Preferences prefs;
    if (!prefs.begin(kNamespace, false)) {
        return;  // NVS unavailable - never let the guard itself block boot
    }
    count_at_boot = prefs.getUChar(kCountKey, 0);
    String stored_rollback = prefs.getString(kRollbackKey, "");
    strlcpy(rollback_info, stored_rollback.c_str(), sizeof(rollback_info));

    const esp_partition_t* running = esp_ota_get_running_partition();
    const esp_partition_t* fallback = NULL;
    bool have_fallback = fallback_partition_valid(running, &fallback);

    BootGuardDecision decision = boot_guard_decide(crash_reset, count_at_boot, have_fallback);

    switch (decision.action) {
        case BootGuardAction::CLEAR:
            if (count_at_boot != 0) {
                prefs.putUChar(kCountKey, 0);
            }
            count_at_boot = 0;
            break;

        case BootGuardAction::COUNT:
            prefs.putUChar(kCountKey, decision.new_count);
            count_at_boot = decision.new_count;
            LOG_BLE("[BOOT_GUARD] Crash reset %u/3 - will roll back to the previous firmware if this continues\n",
                    decision.new_count);
            break;

        case BootGuardAction::ROLLBACK: {
            snprintf(rollback_info, sizeof(rollback_info),
                     "crash loop on v%s #%d -> reverted to '%s' slot",
                     BUILD_FIRMWARE_VERSION, BUILD_NUMBER, fallback->label);
            prefs.putUChar(kCountKey, 0);
            prefs.putString(kRollbackKey, rollback_info);
            prefs.end();
            LOG_BLE("[BOOT_GUARD] %s\n", rollback_info);
            if (esp_ota_set_boot_partition(fallback) == ESP_OK) {
                esp_restart();
            }
            return;  // set_boot_partition failed - continue booting this image
        }

        case BootGuardAction::GIVE_UP:
            prefs.putUChar(kCountKey, 0);
            count_at_boot = 0;
            LOG_BLE("[BOOT_GUARD] Crash loop but no valid fallback image - retrying current firmware\n");
            break;
    }
    prefs.end();
}

void mark_healthy_if_due() {
    if (healthy_marked || millis() < kHealthyUptimeMs) {
        return;
    }
    healthy_marked = true;
    if (count_at_boot == 0) {
        return;  // Nothing to clear; skip the NVS write
    }
    Preferences prefs;
    if (prefs.begin(kNamespace, false)) {
        prefs.putUChar(kCountKey, 0);
        prefs.end();
        LOG_BLE("[BOOT_GUARD] 30s healthy uptime - crash counter cleared\n");
    }
    count_at_boot = 0;
}

const char* last_rollback_info() {
    return rollback_info;
}

}  // namespace BootGuard
