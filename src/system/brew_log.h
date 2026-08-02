#pragma once
#include <cstdint>
#include <cstddef>

/**
 * BrewLog - the queue of brew records awaiting cloud upload.
 *
 * One tiny file per logged shot under /brews - deliberately NOT /sessions:
 * the session directory's retention purge, the cloud manifest scan and the
 * developer wipe all treat every file there as a session. Records are keyed
 * by (session_id, session_timestamp), the same identity pair the manifest
 * uses, because the device never knows a session's content hash.
 *
 * A record is deleted once the server answers 'stored' or 'deleted';
 * 'unknown' (the session hasn't uploaded yet) keeps it queued for the next
 * window. Zero other sync state - a wiped queue just means those shots go
 * unrecorded, and a wiped server never asks for brews at all.
 *
 * Writes happen on the UI task when the user taps Done (one ~20-byte file
 * per shot); reads and deletes happen on the main-loop task inside the
 * cloud sync window. The cached pending count keeps wants_window() free of
 * filesystem scans.
 */

#define BREW_QUEUE_DIR "/brews"
#define BREW_FILE_FORMAT "/brews/brew_%lu.bin"
#define BREW_QUEUE_MAX_FILES 50

struct __attribute__((packed)) BrewRecord {
    uint32_t session_id;
    uint32_t session_timestamp;
    float output_g;
    uint16_t brew_time_s;
    uint16_t reserved;
    uint32_t recorded_epoch;  // 0 when the clock was never synced
};

class BrewLog {
public:
    void init();

    bool queue_record(uint32_t session_id, uint32_t session_timestamp,
                      float output_g, uint16_t brew_time_s);
    // Oldest queued record with session_id strictly greater than after_id
    // (pass 0 to start); lets the uploader walk the queue without re-trying
    // a record the server just answered 'unknown' for.
    bool read_next(uint32_t after_id, BrewRecord* out);
    bool remove(uint32_t session_id);

    uint16_t pending_count() const { return pending; }

private:
    volatile uint16_t pending = 0;
    void prune_if_full();
};

extern BrewLog brew_log;
