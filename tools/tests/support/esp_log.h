#pragma once
// Log macros reference the tag so -Wall doesn't flag it unused; the message
// arguments are still evaluated, matching device-side behaviour.
#define ESP_LOGE(tag, ...) do { (void)(tag); } while (0)
#define ESP_LOGW(tag, ...) do { (void)(tag); } while (0)
#define ESP_LOGI(tag, ...) do { (void)(tag); } while (0)
#define ESP_LOG_ERROR 1
static inline void esp_log_level_set(const char* tag, int level) { (void)tag; (void)level; }
