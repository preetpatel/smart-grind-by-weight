#pragma once
#include <cstdint>

using esp_err_t = int;
constexpr esp_err_t ESP_OK = 0;
enum wifi_ps_type_t { WIFI_PS_NONE, WIFI_PS_MIN_MODEM, WIFI_PS_MAX_MODEM };

esp_err_t esp_wifi_set_max_tx_power(int8_t power);
esp_err_t esp_wifi_get_max_tx_power(int8_t* power);
esp_err_t esp_wifi_set_ps(wifi_ps_type_t mode);
esp_err_t esp_wifi_get_ps(wifi_ps_type_t* mode);
