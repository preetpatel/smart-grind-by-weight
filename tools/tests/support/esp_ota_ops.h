#pragma once
// Stubs for the OTA-apply half of delta.c, which the staging tests never
// reach. All return failure so an accidental call is loud, not silent.

#include "esp_err.h"
#include "esp_partition.h"

typedef unsigned esp_ota_handle_t;
#define OTA_SIZE_UNKNOWN 0xFFFFFFFFu

static inline const esp_partition_t* esp_ota_get_running_partition(void) { return NULL; }
static inline const esp_partition_t* esp_ota_get_next_update_partition(const esp_partition_t* from) {
    (void)from;
    return NULL;
}
static inline const esp_partition_t* esp_ota_get_boot_partition(void) { return NULL; }
static inline esp_err_t esp_ota_begin(const esp_partition_t* p, size_t size, esp_ota_handle_t* handle) {
    (void)p; (void)size; (void)handle;
    return ESP_FAIL;
}
static inline esp_err_t esp_ota_write(esp_ota_handle_t handle, const void* data, size_t size) {
    (void)handle; (void)data; (void)size;
    return ESP_FAIL;
}
static inline esp_err_t esp_ota_end(esp_ota_handle_t handle) { (void)handle; return ESP_FAIL; }
static inline esp_err_t esp_ota_abort(esp_ota_handle_t handle) { (void)handle; return ESP_FAIL; }
static inline esp_err_t esp_ota_set_boot_partition(const esp_partition_t* p) { (void)p; return ESP_FAIL; }
