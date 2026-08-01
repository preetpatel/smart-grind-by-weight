/*
 * SPDX-FileCopyrightText: 2016 Intel Corporation
 *                         2020 Thesis projects
 *
 * SPDX-License-Identifier: Apache 2.0 License
 *
 * SPDX-FileContributor: 2021 Laukik Hase
 */

#include <stdlib.h>
#include <stdint.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "esp_err.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_system.h"

#include "esp_partition.h"
#include "esp_ota_ops.h"

#include "detools.h"
#include "delta.h"

static const char *TAG = "delta";

/* Any flash operation while BLE is streaming (write or erase) stalls the
 * radio and eventually drops the connection on multi-megabyte transfers.
 * Preferred mode holds the entire patch in PSRAM and defers ALL flash work
 * (including the erase) to the flush that runs after the transfer ends.
 * Fallback (no PSRAM) coalesces writes into batches to at least cut the
 * stall frequency. */
#define DELTA_WRITE_BUFFER_SIZE (16 * 1024)
#define DELTA_FLUSH_CHUNK_SIZE  (4 * 1024)
#define DELTA_ERASE_CHUNK_SIZE  (256 * 1024)

typedef struct flash_mem {
    const esp_partition_t *src;
    const esp_partition_t *dest;
    const esp_partition_t *patch;
    size_t src_offset;
    size_t patch_offset;
    esp_ota_handle_t ota_handle;
} flash_mem_t;

static int delta_flash_write_dest(void *arg_p, const uint8_t *buf_p, size_t size)
{
    flash_mem_t *flash;
    flash = (flash_mem_t *)arg_p;

    if (!flash) {
        return -DELTA_CASTING_ERROR;
    }
    if (size <= 0) {
        return -DELTA_INVALID_BUF_SIZE;
    }

    if (esp_ota_write(flash->ota_handle, buf_p, size) != ESP_OK) {
        return -DELTA_WRITING_ERROR;
    }

    return DELTA_OK;
}

static int delta_flash_read_src(void *arg_p, uint8_t *buf_p, size_t size)
{
    flash_mem_t *flash;
    flash = (flash_mem_t *)arg_p;

    if (!flash) {
        return -DELTA_CASTING_ERROR;
    }
    if (size <= 0) {
        return -DELTA_INVALID_BUF_SIZE;
    }

    // For full updates (src is NULL), return zeros
    if (flash->src == NULL) {
        memset(buf_p, 0, size);
        flash->src_offset += size;
        return DELTA_OK;
    }

    if (esp_partition_read(flash->src, flash->src_offset, buf_p, size) != ESP_OK) {
        return -DELTA_READING_SOURCE_ERROR;
    }

    flash->src_offset += size;
    if (flash->src_offset >= flash->src->size) {
        return -DELTA_OUT_OF_MEMORY;
    }

    return DELTA_OK;
}

static int delta_flash_read_patch(void *arg_p, uint8_t *buf_p, size_t size)
{
    flash_mem_t *flash;
    flash = (flash_mem_t *)arg_p;

    if (!flash) {
        return -DELTA_CASTING_ERROR;
    }
    if (size <= 0) {
        return -DELTA_INVALID_BUF_SIZE;
    }

    if (esp_partition_read(flash->patch, flash->patch_offset, buf_p, size) != ESP_OK) {
        return -DELTA_READING_PATCH_ERROR;
    }

    flash->patch_offset += size;
    if (flash->patch_offset >= flash->patch->size) {
        return -DELTA_READING_PATCH_ERROR;
    }

    return DELTA_OK;
}

static int delta_flash_seek_src(void *arg_p, int offset)
{
    flash_mem_t *flash;
    flash = (flash_mem_t *)arg_p;

    if (!flash) {
        return -DELTA_CASTING_ERROR;
    }

    flash->src_offset += offset;
    
    // For full updates (src is NULL), don't check size bounds
    if (flash->src == NULL) {
        return DELTA_OK;
    }
    
    if (flash->src_offset >= flash->src->size) {
        return -DELTA_SEEKING_ERROR;
    }

    return DELTA_OK;
}

static int delta_init_flash_mem(flash_mem_t *flash, const delta_opts_t *opts)
{
    if (!flash) {
        return -DELTA_PARTITION_ERROR;
    }

    // For full updates, we don't need a source partition (install from scratch)
    if (opts->is_full_update) {
        flash->src = NULL;  // No source for full updates
    } else {
        flash->src = esp_ota_get_running_partition();
        if (flash->src == NULL) {
            return -DELTA_PARTITION_ERROR;
        }
        // Allow factory partition as valid source for delta updates
        if (flash->src->subtype >= ESP_PARTITION_SUBTYPE_APP_OTA_MAX && 
            flash->src->subtype != ESP_PARTITION_SUBTYPE_APP_FACTORY) {
            return -DELTA_PARTITION_ERROR;
        }
    }
    
    flash->dest = esp_ota_get_next_update_partition(NULL);
    flash->patch = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_SPIFFS, opts->patch);

    if (flash->dest == NULL || flash->patch == NULL) {
        return -DELTA_PARTITION_ERROR;
    }

    if (flash->dest->subtype >= ESP_PARTITION_SUBTYPE_APP_OTA_MAX) {
        return -DELTA_PARTITION_ERROR;
    }

    if (esp_ota_begin(flash->dest, OTA_SIZE_UNKNOWN, &(flash->ota_handle)) != ESP_OK) {
        return -DELTA_PARTITION_ERROR;
    }
    esp_log_level_set("esp_image", ESP_LOG_ERROR);

    flash->src_offset = 0;
    flash->patch_offset = 0;

    return DELTA_OK;
}

static int delta_set_boot_partition(flash_mem_t *flash)
{
    esp_err_t err = esp_ota_set_boot_partition(flash->dest);
    free(flash);

    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Could not set boot partition: %s", esp_err_to_name(err));
        return -DELTA_TARGET_IMAGE_ERROR;
    }

    const esp_partition_t *boot_partition = esp_ota_get_boot_partition();
    ESP_LOGI(TAG, "Next Boot Partition: Subtype %d at Offset 0x%x", boot_partition->subtype, boot_partition->address);
    ESP_LOGI(TAG, "Ready to reboot!!!");

    return DELTA_OK;
}

static int delta_partition_erase(const delta_partition_writer_t *writer)
{
    size_t patch_page_size = ((writer->size + PARTITION_PAGE_SIZE - 1) / PARTITION_PAGE_SIZE) * PARTITION_PAGE_SIZE;
    size_t erased = 0;

    while (erased < patch_page_size) {
        size_t chunk = patch_page_size - erased;
        if (chunk > DELTA_ERASE_CHUNK_SIZE) {
            chunk = DELTA_ERASE_CHUNK_SIZE;
        }

        if (esp_partition_erase_range((const esp_partition_t *)writer->patch, erased, chunk) != ESP_OK) {
            ESP_LOGE(TAG, "Partition Error: Could not erase '%s' region!", writer->name);
            return ESP_FAIL;
        }

        erased += chunk;
    }
    return ESP_OK;
}

int delta_partition_init(delta_partition_writer_t *writer, const char *partition, int patch_size)
{
    if (writer == NULL || partition == NULL) {
        return -DELTA_INVALID_ARGUMENT_ERROR;
    }

    const esp_partition_t *patch = esp_partition_find_first(ESP_PARTITION_TYPE_DATA,
        ESP_PARTITION_SUBTYPE_DATA_SPIFFS, partition);
    if (patch == NULL) {
        ESP_LOGE(TAG, "Partition Error: Could not find '%s' partition", partition);
        return ESP_FAIL;
    }

    writer->name = partition;
    writer->patch = patch;
    writer->size = patch_size;
    writer->offset = 0;

    /* Re-init without deinit must not leak a previous buffer. */
    delta_partition_deinit(writer);

    /* Preferred: hold the whole patch in PSRAM, defer every flash operation
     * (erase included) until after the BLE transfer completes. */
    writer->buf = (char *)heap_caps_malloc(patch_size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (writer->buf != NULL) {
        writer->buf_cap = patch_size;
        writer->buf_fill = 0;
        writer->deferred = 1;
        return ESP_OK;
    }

    /* Fallback: stream to flash in batches. Erase up front like before. */
    ESP_LOGW(TAG, "No PSRAM for patch staging - streaming to flash in batches");
    if (delta_partition_erase(writer) != ESP_OK) {
        return ESP_FAIL;
    }
    writer->buf = (char *)heap_caps_malloc(DELTA_WRITE_BUFFER_SIZE, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (writer->buf != NULL) {
        writer->buf_cap = DELTA_WRITE_BUFFER_SIZE;
    } else {
        ESP_LOGW(TAG, "No RAM for staging buffer - falling back to unbuffered writes");
        writer->buf_cap = 0;
    }
    writer->buf_fill = 0;
    writer->deferred = 0;

    return ESP_OK;
}

/* Streaming-mode helper: write out the staged batch. */
static int delta_partition_write_batch(delta_partition_writer_t *writer)
{
    if (writer->buf_fill == 0) {
        return ESP_OK;
    }
    if (esp_partition_write((const esp_partition_t *)writer->patch, writer->offset, writer->buf, writer->buf_fill) != ESP_OK) {
        ESP_LOGE(TAG, "Partition Error: Could not write to '%s' region!", writer->name);
        return ESP_FAIL;
    }
    writer->offset += writer->buf_fill;
    writer->buf_fill = 0;
    return ESP_OK;
}

int delta_partition_write(delta_partition_writer_t *writer, const char *buf, int size)
{
    if (writer == NULL || buf == NULL) {
        return -DELTA_INVALID_ARGUMENT_ERROR;
    }

    if (writer->offset + writer->buf_fill + size > writer->size) {
        return -DELTA_OUT_OF_BOUNDS_ERROR;
    }

    if (writer->deferred) {
        memcpy(writer->buf + writer->buf_fill, buf, size);
        writer->buf_fill += size;
        return ESP_OK;
    }

    if (writer->buf_cap == 0) {
        /* Unbuffered fallback */
        if (esp_partition_write((const esp_partition_t *)writer->patch, writer->offset, buf, size) != ESP_OK) {
            ESP_LOGE(TAG, "Partition Error: Could not write to '%s' region!", writer->name);
            return ESP_FAIL;
        }
        writer->offset += size;
        return ESP_OK;
    }

    while (size > 0) {
        int space = writer->buf_cap - writer->buf_fill;
        int n = (size < space) ? size : space;
        memcpy(writer->buf + writer->buf_fill, buf, n);
        writer->buf_fill += n;
        buf += n;
        size -= n;

        if (writer->buf_fill == writer->buf_cap) {
            int err = delta_partition_write_batch(writer);
            if (err != ESP_OK) {
                return err;
            }
        }
    }
    return ESP_OK;
}

int delta_partition_flush(delta_partition_writer_t *writer)
{
    if (writer == NULL) {
        return -DELTA_INVALID_ARGUMENT_ERROR;
    }

    if (!writer->deferred) {
        return delta_partition_write_batch(writer);
    }

    /* Deferred mode: the transfer is done, flash stalls no longer threaten
     * the BLE link. Erase, then copy the PSRAM-staged patch through a small
     * internal-RAM scratch buffer (esp_partition_write must not source
     * directly from external RAM on all IDF versions). */
    ESP_LOGI(TAG, "Writing staged patch (%d bytes) to '%s'", writer->buf_fill, writer->name);
    if (delta_partition_erase(writer) != ESP_OK) {
        return ESP_FAIL;
    }

    char *scratch = (char *)heap_caps_malloc(DELTA_FLUSH_CHUNK_SIZE, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (scratch == NULL) {
        return -DELTA_OUT_OF_MEMORY;
    }

    int written = 0;
    while (written < writer->buf_fill) {
        int n = writer->buf_fill - written;
        if (n > DELTA_FLUSH_CHUNK_SIZE) {
            n = DELTA_FLUSH_CHUNK_SIZE;
        }
        memcpy(scratch, writer->buf + written, n);
        if (esp_partition_write((const esp_partition_t *)writer->patch, written, scratch, n) != ESP_OK) {
            ESP_LOGE(TAG, "Partition Error: Could not write to '%s' region!", writer->name);
            free(scratch);
            return ESP_FAIL;
        }
        written += n;
    }
    free(scratch);

    writer->offset = written;
    writer->buf_fill = 0;
    return ESP_OK;
}

void delta_partition_deinit(delta_partition_writer_t *writer)
{
    if (writer == NULL) {
        return;
    }
    if (writer->buf != NULL) {
        free(writer->buf);
    }
    writer->buf = NULL;
    writer->buf_cap = 0;
    writer->buf_fill = 0;
    writer->deferred = 0;
}

uint32_t delta_crc32(uint32_t crc, const void *data, unsigned int length)
{
    /* Bitwise CRC-32 (reflected, poly 0xEDB88320) - zlib-compatible. ~1 ms
     * per 100 KB at 240 MHz; table-free so host tests run the same code. */
    const uint8_t *bytes = (const uint8_t *)data;
    crc = ~crc;
    for (unsigned int i = 0; i < length; i++) {
        crc ^= bytes[i];
        for (int bit = 0; bit < 8; bit++) {
            crc = (crc >> 1) ^ (0xEDB88320UL & (uint32_t)(-(int32_t)(crc & 1)));
        }
    }
    return ~crc;
}

int delta_partition_verify_crc32(const delta_partition_writer_t *writer, int size, uint32_t expected)
{
    if (writer == NULL || writer->patch == NULL || size < 0) {
        return -DELTA_INVALID_ARGUMENT_ERROR;
    }

    char *scratch = (char *)heap_caps_malloc(DELTA_FLUSH_CHUNK_SIZE, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (scratch == NULL) {
        return -DELTA_OUT_OF_MEMORY;
    }

    uint32_t crc = 0;
    int offset = 0;
    while (offset < size) {
        int n = size - offset;
        if (n > DELTA_FLUSH_CHUNK_SIZE) {
            n = DELTA_FLUSH_CHUNK_SIZE;
        }
        if (esp_partition_read((const esp_partition_t *)writer->patch, offset, scratch, n) != ESP_OK) {
            free(scratch);
            return -DELTA_READING_PATCH_ERROR;
        }
        crc = delta_crc32(crc, scratch, (unsigned int)n);
        offset += n;
    }
    free(scratch);

    if (crc != expected) {
        ESP_LOGE(TAG, "Patch checksum mismatch: expected 0x%08x, flash has 0x%08x",
                 (unsigned int)expected, (unsigned int)crc);
        return -DELTA_PATCH_CHECKSUM_ERROR;
    }
    return DELTA_OK;
}

int delta_check_and_apply(int patch_size, const delta_opts_t *opts)
{
    static const delta_opts_t DEFAULT_DELTA_OPTS = {
        .src = DEFAULT_PARTITION_LABEL_SRC,
        .dest = DEFAULT_PARTITION_LABEL_DEST,
        .patch = DEFAULT_PARTITION_LABEL_PATCH,
        .is_full_update = 0
    };

    ESP_LOGI(TAG, "Initializing delta update...");

    flash_mem_t *flash = NULL;
    int ret = 0;

    if (patch_size < 0) {
        return patch_size;
    } else if (patch_size > 0) {
        flash = (flash_mem_t *)calloc(1, sizeof(flash_mem_t));
        if (!flash) {
            return -DELTA_OUT_OF_MEMORY;
        }

        if (!opts) {
            opts = &DEFAULT_DELTA_OPTS;
        }

        /* No OTA handle is open yet if this fails, so only the struct needs freeing. */
        ret = delta_init_flash_mem(flash, opts);
        if (ret) {
            free(flash);
            return ret;
        }

        ret = detools_apply_patch_callbacks(delta_flash_read_src,
                                            delta_flash_seek_src,
                                            delta_flash_read_patch,
                                            (size_t) patch_size,
                                            delta_flash_write_dest,
                                            flash);

        if (ret <= 0) {
            esp_ota_abort(flash->ota_handle);
            free(flash);
            return ret;
        }

        /* Flushes the trailing partial write and verifies the reconstructed
         * image. The handle is released either way, so it must not be aborted
         * afterwards. */
        esp_err_t err = esp_ota_end(flash->ota_handle);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "Target image validation failed: %s", esp_err_to_name(err));
            free(flash);
            return -DELTA_TARGET_IMAGE_ERROR;
        }

        ESP_LOGI(TAG, "Patch Successful!!!");
        return delta_set_boot_partition(flash);
    }

    return 0;
}

const char *delta_error_as_string(int error)
{
    if (error < 28) {
        return detools_error_as_string(error);
    }

    if (error < 0) {
        error *= -1;
    }

    switch (error) {
    case DELTA_OUT_OF_MEMORY:
        return "Target partition out of memory.";
    case DELTA_READING_PATCH_ERROR:
        return "Error reading patch binary.";
    case DELTA_READING_SOURCE_ERROR:
        return "Error reading source image.";
    case DELTA_WRITING_ERROR:
        return "Error writing to target image.";
    case DELTA_SEEKING_ERROR:
        return "Seek error: source image.";
    case DELTA_CASTING_ERROR:
        return "Error casting to flash_mem_t.";
    case DELTA_INVALID_BUF_SIZE:
        return "Read/write buffer less or equal to 0.";
    case DELTA_CLEARING_ERROR:
        return "Could not erase target region.";
    case DELTA_PARTITION_ERROR:
        return "Flash partition not found.";
    case DELTA_TARGET_IMAGE_ERROR:
        return "Invalid target image to boot from.";
    case DELTA_PATCH_CHECKSUM_ERROR:
        return "Patch checksum mismatch.";
    default:
        return "Unknown error.";
    }
}
