#pragma once
// In-memory fake of the ESP-IDF partition API, backing a single "patch"
// partition. Enforces NOR-flash semantics: writes to bytes that were not
// erased (0xFF) first fail, so a missing erase is caught as a test failure
// rather than passing silently like a RAM buffer would.

#include <stdlib.h>
#include <string.h>

#include "esp_err.h"

typedef enum {
    ESP_PARTITION_TYPE_APP = 0x00,
    ESP_PARTITION_TYPE_DATA = 0x01,
} esp_partition_type_t;

typedef enum {
    ESP_PARTITION_SUBTYPE_APP_FACTORY = 0x00,
    ESP_PARTITION_SUBTYPE_APP_OTA_MAX = 0x20,
    ESP_PARTITION_SUBTYPE_DATA_SPIFFS = 0x82,
} esp_partition_subtype_t;

typedef struct esp_partition_t {
    const char* label;
    unsigned address;
    unsigned size;
    int subtype;
    unsigned char* data;
} esp_partition_t;

#define FAKE_PATCH_PARTITION_SIZE (2u * 1024u * 1024u)
static unsigned char g_fake_patch_storage[FAKE_PATCH_PARTITION_SIZE];
static esp_partition_t g_fake_patch_partition = {
    "patch", 0, FAKE_PATCH_PARTITION_SIZE, ESP_PARTITION_SUBTYPE_DATA_SPIFFS, g_fake_patch_storage,
};

// Test hooks / instrumentation
static int g_partition_write_calls = 0;
static int g_partition_erase_calls = 0;
static int g_fail_write_after = 0;  // fail once write call count reaches this (0 = never)

static inline void fake_partition_reset(void) {
    memset(g_fake_patch_storage, 0x00, sizeof(g_fake_patch_storage));  // deliberately NOT erased
    g_partition_write_calls = 0;
    g_partition_erase_calls = 0;
    g_fail_write_after = 0;
}

static inline const esp_partition_t* esp_partition_find_first(esp_partition_type_t type,
                                                              esp_partition_subtype_t subtype,
                                                              const char* label) {
    (void)type;
    (void)subtype;
    if (label != NULL && strcmp(label, "patch") == 0) {
        return &g_fake_patch_partition;
    }
    return NULL;
}

static inline esp_err_t esp_partition_erase_range(const esp_partition_t* p, size_t offset, size_t size) {
    if (p == NULL || offset + size > p->size) return ESP_FAIL;
    g_partition_erase_calls++;
    memset(p->data + offset, 0xFF, size);
    return ESP_OK;
}

static inline esp_err_t esp_partition_write(const esp_partition_t* p, size_t offset,
                                            const void* src, size_t size) {
    if (p == NULL || src == NULL || offset + size > p->size) return ESP_FAIL;
    g_partition_write_calls++;
    if (g_fail_write_after > 0 && g_partition_write_calls >= g_fail_write_after) return ESP_FAIL;
    for (size_t i = 0; i < size; i++) {
        if (p->data[offset + i] != 0xFF) return ESP_FAIL;  // NOR: must erase before write
    }
    memcpy(p->data + offset, src, size);
    return ESP_OK;
}

static inline esp_err_t esp_partition_read(const esp_partition_t* p, size_t offset,
                                           void* dst, size_t size) {
    if (p == NULL || dst == NULL || offset + size > p->size) return ESP_FAIL;
    memcpy(dst, p->data + offset, size);
    return ESP_OK;
}
