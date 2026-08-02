#include "brew_log.h"
#include <Arduino.h>
#include <LittleFS.h>
#include <cstring>
#include "../config/constants.h"
#include "time_sync.h"

BrewLog brew_log;

namespace {
    // "/brews/brew_123.bin" -> 123, or 0 for anything else in the directory.
    uint32_t id_from_name(const char* path) {
        const char* underscore = strrchr(path, '_');
        return underscore ? strtoul(underscore + 1, nullptr, 10) : 0;
    }
}

void BrewLog::init() {
    if (!LittleFS.exists(BREW_QUEUE_DIR)) {
        LittleFS.mkdir(BREW_QUEUE_DIR);
    }
    uint16_t count = 0;
    File dir = LittleFS.open(BREW_QUEUE_DIR);
    if (dir && dir.isDirectory()) {
        File file = dir.openNextFile();
        while (file) {
            if (!file.isDirectory()) count++;
            file.close();
            file = dir.openNextFile();
        }
        dir.close();
    }
    pending = count;
    if (count) LOG_BLE("[BREW] %u queued brew record(s) on flash\n", count);
}

void BrewLog::prune_if_full() {
    if (pending < BREW_QUEUE_MAX_FILES) return;
    // Drop the oldest record: shots the server never learned about in 50
    // grinds' time are stale enough to lose.
    uint32_t oldest = UINT32_MAX;
    File dir = LittleFS.open(BREW_QUEUE_DIR);
    if (dir && dir.isDirectory()) {
        File file = dir.openNextFile();
        while (file) {
            if (!file.isDirectory()) {
                uint32_t id = id_from_name(file.name());
                if (id && id < oldest) oldest = id;
            }
            file.close();
            file = dir.openNextFile();
        }
        dir.close();
    }
    if (oldest != UINT32_MAX) remove(oldest);
}

bool BrewLog::queue_record(uint32_t session_id, uint32_t session_timestamp,
                           float output_g, uint16_t brew_time_s) {
    if (!session_id || !(output_g > 0.0f)) return false;
    prune_if_full();

    BrewRecord record = {};
    record.session_id = session_id;
    record.session_timestamp = session_timestamp;
    record.output_g = output_g;
    record.brew_time_s = brew_time_s;
    record.recorded_epoch = TimeSync::is_synced() ? TimeSync::now_epoch() : 0;

    char path[48];
    snprintf(path, sizeof(path), BREW_FILE_FORMAT, (unsigned long)session_id);
    bool existed = LittleFS.exists(path);  // Re-entering the same shot overwrites
    File file = LittleFS.open(path, "w");
    if (!file) {
        LOG_BLE("[BREW] Failed to open %s for write\n", path);
        return false;
    }
    bool ok = file.write((const uint8_t*)&record, sizeof(record)) == sizeof(record);
    file.close();
    if (!ok) {
        LittleFS.remove(path);
        return false;
    }
    if (!existed) pending = pending + 1;
    LOG_BLE("[BREW] Queued shot for session %lu: %.1fg over %us\n",
            (unsigned long)session_id, output_g, (unsigned)brew_time_s);
    return true;
}

bool BrewLog::read_next(uint32_t after_id, BrewRecord* out) {
    if (!out) return false;
    uint32_t best = UINT32_MAX;
    File dir = LittleFS.open(BREW_QUEUE_DIR);
    if (!dir || !dir.isDirectory()) return false;
    File file = dir.openNextFile();
    while (file) {
        if (!file.isDirectory()) {
            uint32_t id = id_from_name(file.name());
            if (id > after_id && id < best) best = id;
        }
        file.close();
        file = dir.openNextFile();
    }
    dir.close();
    if (best == UINT32_MAX) return false;

    char path[48];
    snprintf(path, sizeof(path), BREW_FILE_FORMAT, (unsigned long)best);
    File record_file = LittleFS.open(path, "r");
    if (!record_file) return false;
    bool ok = record_file.read((uint8_t*)out, sizeof(*out)) == sizeof(*out);
    record_file.close();
    if (!ok || out->session_id != best) {
        // Corrupt or mis-named; drop it rather than wedging the queue.
        remove(best);
        return read_next(after_id, out);
    }
    return true;
}

bool BrewLog::remove(uint32_t session_id) {
    char path[48];
    snprintf(path, sizeof(path), BREW_FILE_FORMAT, (unsigned long)session_id);
    if (!LittleFS.exists(path)) return false;
    bool ok = LittleFS.remove(path);
    if (ok && pending > 0) pending = pending - 1;
    return ok;
}
