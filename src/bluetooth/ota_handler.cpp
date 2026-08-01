#include "ota_handler.h"
#include "../config/build_info.h"
#include "../config/logging.h"
#include "../system/time_sync.h"
#include "../hardware/touch_driver.h"
#include "../hardware/hardware_manager.h"
#include "../tasks/task_manager.h"
#include <Arduino.h>
#include <BLEDevice.h>

OTAHandler::OTAHandler()
    : ota_in_progress(false)
    , apply_in_progress(false)
    , patch_size(0)
    , received_size(0)
    , last_chunk_time_ms(0)
    , current_status(BLE_OTA_IDLE)
    , current_firmware_build_number("")
    , is_full_update(false)
    , expected_patch_crc(0)
    , patch_crc_present(false)
    , patch_writer{} {
}

void OTAHandler::record_outcome(const char* outcome) {
    if (!preferences || !outcome) {
        return;
    }
    preferences->putString("last_ota", outcome);
    preferences->putUInt("last_ota_ts", TimeSync::now_epoch());
    LOG_BLE("OTA: Outcome recorded: %s\n", outcome);
}

OTAHandler::~OTAHandler() {
    if (ota_in_progress) {
        abort_ota();
    }
}

void OTAHandler::init(Preferences* prefs) {
    preferences = prefs;
    LOG_BLE("OTA: Handler initialized (CPU: %luMHz)\n", (unsigned long)getCpuFrequencyMhz());

    // Get current firmware build number
    current_firmware_build_number = String(BUILD_NUMBER);
}

bool OTAHandler::start_ota(uint32_t size, const String& expected_build_number, bool is_full_update, const String& expected_firmware_version) {
    LOG_OTA_DEBUG("start_ota() called - size=%lu, build=%s, full=%d\n", 
                  (unsigned long)size, expected_build_number.c_str(), is_full_update);
    
    if (ota_in_progress) {
        LOG_BLE("OTA: Update already in progress\n");
        LOG_OTA_DEBUG("start_ota() FAILED - already in progress\n");
        return false;
    }
    
    patch_size = size;
    received_size = 0;
    this->is_full_update = is_full_update;
    expected_patch_crc = 0;
    patch_crc_present = false;
    
    LOG_BLE("OTA: Starting %s update (%lu KB)\n", is_full_update ? "full" : "delta", (unsigned long)patch_size / 1024);
    LOG_OTA_DEBUG("patch_size=%lu, received_size=%lu, is_full_update=%d\n", 
                  (unsigned long)patch_size, (unsigned long)received_size, this->is_full_update);
    
    // Store expected build number and firmware version for post-reboot verification
    if (!expected_build_number.isEmpty() && preferences) {
        preferences->putString("new_build_nr", expected_build_number);
        LOG_OTA_DEBUG("Stored expected build number: %s\n", expected_build_number.c_str());
    } else {
        LOG_OTA_DEBUG("No expected build number to store\n");
    }
    
    if (!expected_firmware_version.isEmpty() && preferences) {
        preferences->putString("new_fw_ver", expected_firmware_version);
        LOG_OTA_DEBUG("Stored expected firmware version: %s\n", expected_firmware_version.c_str());
    } else if (expected_build_number.isEmpty()) {
        LOG_OTA_DEBUG("No expected firmware version to store\n");
    }
    
    // Reconfigure task watchdog for OTA process with extended timeout
    // This is a CPU and flash-intensive operation that can starve other tasks
    LOG_BLE("OTA: Reconfiguring task watchdog timer for OTA process (1800s timeout)...\n");
    LOG_OTA_DEBUG("Configuring watchdog - timeout_ms=1800000, cores=0x3\n");
    esp_task_wdt_config_t wdt_config = {
        .timeout_ms = 1800000,
        .idle_core_mask = (1 << 0) | (1 << 1), // Watch idle tasks on both cores
        .trigger_panic = true,
    };
    esp_task_wdt_reconfigure(&wdt_config);
    LOG_OTA_DEBUG("Watchdog reconfigured successfully\n");

    // Suspend hardware tasks to prevent watchdog timeouts during OTA
    LOG_BLE("OTA: Suspending hardware tasks...\n");
    task_manager.suspend_hardware_tasks();

    LOG_OTA_DEBUG("Calling start_update()...\n");
    if (!start_update()) {
        current_status = BLE_OTA_ERROR;
        record_outcome("start: patch partition init failed");
        LOG_OTA_DEBUG("start_update() FAILED\n");
        
        // Resume hardware tasks on failure
        LOG_BLE("OTA: Resuming hardware tasks after failed start\n");
        task_manager.resume_hardware_tasks();
        return false;
    }
    LOG_OTA_DEBUG("start_update() SUCCESS\n");
    
    ota_in_progress = true;
    last_chunk_time_ms = millis();
    current_status = BLE_OTA_RECEIVING;
    LOG_OTA_DEBUG("OTA started successfully - status=BLE_OTA_RECEIVING\n");
    return true;
}

bool OTAHandler::process_data_chunk(const uint8_t* data, size_t size) {
    if (!ota_in_progress) {
        return false;
    }
    
    // Write patch data to patch partition
    if (delta_partition_write(&patch_writer, (const char*)data, size) != ESP_OK) {
        LOG_BLE("OTA: Patch write failed at offset %lu\n", (unsigned long)received_size);
        if (current_status != BLE_OTA_ERROR) {  // record the first failure only
            char msg[64];
            snprintf(msg, sizeof(msg), "receive: staging write failed at %lu",
                     (unsigned long)received_size);
            record_outcome(msg);
        }
        current_status = BLE_OTA_ERROR;
        return false;
    }
    
    received_size += size;
    last_chunk_time_ms = millis();

    // Progress logging every 16KB for better visibility, plus at start and end
    if (received_size % 16384 == 0 || received_size == size || received_size == patch_size) {
        LOG_BLE("OTA: Transfer %lu KB / %lu KB (%.1f%%)\n", 
                     (unsigned long)received_size / 1024, (unsigned long)patch_size / 1024, 
                     get_progress());
    }
    
    return true;
}

bool OTAHandler::complete_ota() {
    LOG_OTA_DEBUG("complete_ota() called\n");
    
    if (!ota_in_progress) {
        LOG_BLE("OTA: No update in progress\n");
        LOG_OTA_DEBUG("complete_ota() FAILED - no update in progress\n");
        return false;
    }
    
    LOG_BLE("OTA: Finalizing update...\n");
    LOG_OTA_DEBUG("patch_size=%lu, received_size=%lu\n",
                  (unsigned long)patch_size, (unsigned long)received_size);

    // From here on the update is no longer abortable: the stall watchdog and
    // disconnect handling both check this flag and stand down.
    apply_in_progress = true;

    // Kamikaze mode: Disable all non-essential systems before flash operations
    LOG_BLE("OTA: Entering kamikaze mode - disabling non-essential systems...\n");
    LOG_OTA_DEBUG("Starting kamikaze mode shutdown sequence...\n");
    
    // Disable I2C operations (TouchDriver) - access through hardware_manager
    extern HardwareManager hardware_manager;
    LOG_OTA_DEBUG("Disabling TouchDriver I2C operations...\n");
    hardware_manager.get_display()->get_touch_driver()->disable();
    LOG_OTA_DEBUG("TouchDriver disabled\n");
    
    // Skip BLE deinitialization - causes hang in kamikaze mode
    // BLE stack will be destroyed during system restart anyway
    // BLEDevice::deinit(true);
    LOG_OTA_DEBUG("Skipping BLE deinit (causes hang) - kamikaze restart will handle cleanup\n");
    
    LOG_OTA_DEBUG("Calling finalize_update()...\n");
    bool success = finalize_update();
    if (success) {
        current_status = BLE_OTA_SUCCESS;
        LOG_OTA_DEBUG("finalize_update() SUCCESS\n");
        LOG_BLE("OTA: Update complete (%lu KB) - ready to reboot\n", (unsigned long)received_size / 1024);
        char msg[64];
        snprintf(msg, sizeof(msg), "success: %s applied (%lu KB)",
                 is_full_update ? "full update" : "delta",
                 (unsigned long)received_size / 1024);
        record_outcome(msg);
        // The caller notifies the client of success and restarts; hardware
        // tasks stay suspended for the few remaining milliseconds.
    } else {
        current_status = BLE_OTA_ERROR;
        LOG_BLE("OTA: Finalization failed\n");
        LOG_OTA_DEBUG("finalize_update() FAILED\n");

        // Resume hardware tasks on failure
        LOG_BLE("OTA: Resuming hardware tasks after failed finalization\n");
        task_manager.resume_hardware_tasks();
    }

    ota_in_progress = false;
    apply_in_progress = false;
    LOG_OTA_DEBUG("complete_ota() returning %s\n", success ? "SUCCESS" : "FAILED");
    return success;
}

void OTAHandler::abort_ota(const char* reason) {
    if (apply_in_progress) {
        // Too late to abort - the target partition is mid-rewrite and the
        // hardware tasks must stay suspended until the apply resolves.
        LOG_BLE("OTA: Ignoring abort during patch apply\n");
        return;
    }
    if (ota_in_progress) {
        LOG_BLE("OTA: Aborting update (%s)\n", reason ? reason : "no reason");
        if (current_status != BLE_OTA_ERROR) {  // keep the first recorded failure
            record_outcome(reason);
        }
        ota_in_progress = false;
        received_size = 0;
        patch_size = 0;
        current_status = BLE_OTA_ERROR;
        delta_partition_deinit(&patch_writer);

        // Resume hardware tasks on abort
        LOG_BLE("OTA: Resuming hardware tasks after abort\n");
        task_manager.resume_hardware_tasks();
    }
}

bool OTAHandler::check_stalled_transfer() {
    if (!ota_in_progress || apply_in_progress) {
        // Chunks stop arriving the moment the transfer completes, so the
        // 30-90s apply phase would always read as "stalled" - it isn't.
        return false;
    }

    if (millis() - last_chunk_time_ms < BLE_OTA_STALL_TIMEOUT_MS) {
        return false;
    }

    LOG_BLE("OTA: No data for %lu ms at %.1f%% - aborting stalled transfer\n",
                 (unsigned long)(millis() - last_chunk_time_ms), get_progress());
    abort_ota("aborted: transfer stalled");
    return true;
}

float OTAHandler::get_progress() const {
    if (patch_size == 0) return 0.0f;
    return 100.0f * received_size / patch_size;
}

bool OTAHandler::start_update() {
    // Initialize patch partition for writing
    if (delta_partition_init(&patch_writer, "patch", patch_size) != ESP_OK) {
        LOG_BLE("OTA: Failed to initialize patch partition\n");
        return false;
    }
    return true;
}

bool OTAHandler::finalize_update() {
    LOG_OTA_DEBUG("finalize_update() called\n");

    // Flush the staged patch to flash and release the staging buffer - the
    // apply phase needs the heap more than we do.
    int flush_result = delta_partition_flush(&patch_writer);
    delta_partition_deinit(&patch_writer);
    if (flush_result != ESP_OK) {
        LOG_BLE("OTA: Failed to flush patch staging buffer\n");
        record_outcome("apply: patch flush to flash failed");
        return false;
    }

    // Verify received size matches expected
    LOG_OTA_DEBUG("Verifying received size: expected=%lu, got=%lu\n",
                  (unsigned long)patch_size, (unsigned long)received_size);
    if (received_size != patch_size) {
        LOG_BLE("OTA: Size mismatch - expected %lu, got %lu\n",
                     (unsigned long)patch_size, (unsigned long)received_size);
        LOG_OTA_DEBUG("Size verification FAILED\n");
        char msg[64];
        snprintf(msg, sizeof(msg), "apply: size mismatch (%lu of %lu)",
                 (unsigned long)received_size, (unsigned long)patch_size);
        record_outcome(msg);
        return false;
    }
    LOG_OTA_DEBUG("Size verification SUCCESS\n");

    // Verify the client's CRC-32 against the patch as it landed in flash -
    // catches both transfer corruption and bad flash writes before the
    // 30-90s erase+apply cycle starts. Older clients don't send one.
    if (patch_crc_present) {
        int crc_result = delta_partition_verify_crc32(&patch_writer, (int)patch_size, expected_patch_crc);
        if (crc_result != DELTA_OK) {
            LOG_BLE("OTA: Patch checksum verification failed: %s\n", delta_error_as_string(crc_result));
            record_outcome("apply: patch checksum mismatch");
            return false;
        }
        LOG_BLE("OTA: Patch checksum verified (crc32 0x%08lx)\n", (unsigned long)expected_patch_crc);
    } else {
        LOG_BLE("OTA: No patch checksum provided - skipping verification\n");
    }
    
    // A/B Partition Update Logic
    LOG_OTA_DEBUG("Getting running partition...\n");
    const esp_partition_t* running_partition = esp_ota_get_running_partition();
    if (!running_partition) {
        LOG_BLE("❌ Could not get running partition!\n");
        LOG_OTA_DEBUG("esp_ota_get_running_partition() FAILED\n");
        record_outcome("apply: no running partition");
        return false;
    }
    LOG_OTA_DEBUG("Running partition: %s (addr=0x%lx, size=%lu)\n", 
                  running_partition->label, (unsigned long)running_partition->address, 
                  (unsigned long)running_partition->size);

    LOG_OTA_DEBUG("Getting next update partition...\n");
    const esp_partition_t* update_partition = esp_ota_get_next_update_partition(NULL);
    if (!update_partition) {
        LOG_BLE("❌ Could not find a valid OTA update partition!\n");
        LOG_OTA_DEBUG("esp_ota_get_next_update_partition() FAILED\n");
        record_outcome("apply: no update partition");
        return false;
    }
    LOG_OTA_DEBUG("Update partition: %s (addr=0x%lx, size=%lu)\n", 
                  update_partition->label, (unsigned long)update_partition->address, 
                  (unsigned long)update_partition->size);
    
    LOG_BLE("OTA Info: Running from '%s', updating to '%s'\n", 
                  running_partition->label, update_partition->label);

    // Set up delta options for the A/B update
    LOG_OTA_DEBUG("Setting up delta options...\n");
    delta_opts_t opts;
    opts.src = running_partition->label;
    opts.dest = update_partition->label;
    opts.patch = "patch";
    opts.is_full_update = this->is_full_update ? 1 : 0;
    LOG_OTA_DEBUG("Delta opts: src=%s, dest=%s, patch=%s, is_full=%d\n", 
                  opts.src, opts.dest, opts.patch, opts.is_full_update);
    
    // Apply the delta patch
    LOG_OTA_DEBUG("Calling delta_check_and_apply() with size=%lu...\n", (unsigned long)patch_size);
    Serial.flush();
    int result = delta_check_and_apply(patch_size, &opts);
    LOG_OTA_DEBUG("delta_check_and_apply() returned: %d\n", result);
    if (result < 0) {
        LOG_BLE("Delta patch failed: %s\n", delta_error_as_string(result));
        LOG_OTA_DEBUG("Delta patch FAILED with error: %s\n", delta_error_as_string(result));
        char msg[96];
        snprintf(msg, sizeof(msg), "apply: %s (%d)", delta_error_as_string(result), result);
        record_outcome(msg);
        return false;
    }
    
    LOG_OTA_DEBUG("finalize_update() SUCCESS - delta patch applied\n");
    return true;
}

String OTAHandler::check_ota_failure_after_boot() {
    if (!preferences) {
        return "";
    }

    String expected_build = preferences->getString("new_build_nr", "");
    String expected_version = preferences->getString("new_fw_ver", "");

    if (expected_build.isEmpty() && expected_version.isEmpty()) {
        return "";
    }

    int current_build = BUILD_NUMBER;
    String current_version = BUILD_FIRMWARE_VERSION;

    // Web flasher sends firmware version - use that for verification (more reliable)
    if (!expected_version.isEmpty()) {
        if (expected_version != current_version) {
            LOG_BLE("OTA: Version check failed - expected v%s, got v%s\n",
                         expected_version.c_str(), current_version.c_str());
            char msg[80];
            snprintf(msg, sizeof(msg), "verify: still on v%s, expected v%s",
                     current_version.c_str(), expected_version.c_str());
            record_outcome(msg);
            preferences->remove("new_build_nr");
            preferences->remove("new_fw_ver");
            return expected_version;  // Return expected version for display
        } else {
            LOG_BLE("OTA: Version check passed - expected v%s, got v%s\n",
                         expected_version.c_str(), current_version.c_str());
            preferences->remove("new_build_nr");
            preferences->remove("new_fw_ver");
            return "";
        }
    }

    // Python flasher sends build number only - use that for verification
    if (!expected_build.isEmpty()) {
        int expected_build_num = expected_build.toInt();
        if (current_build != expected_build_num) {
            LOG_BLE("OTA: Build number check failed - expected #%d, got #%d\n",
                         expected_build_num, current_build);
            char msg[64];
            snprintf(msg, sizeof(msg), "verify: still on #%d, expected #%d",
                     current_build, expected_build_num);
            record_outcome(msg);
            preferences->remove("new_build_nr");
            preferences->remove("new_fw_ver");
            return expected_build;
        } else {
            LOG_BLE("OTA: Build number check passed - expected #%d, got #%d\n",
                         expected_build_num, current_build);
            preferences->remove("new_build_nr");
            preferences->remove("new_fw_ver");
            return "";
        }
    }

    // Clean up if we get here (no verification data)
    preferences->remove("new_build_nr");
    preferences->remove("new_fw_ver");
    return "";
}
