#pragma once

#include <esp_wifi.h>

// Call after WiFi.mode(WIFI_STA) starts the driver, before WiFi.begin() can
// scan/associate. Reapply on every window: radio teardown discards this state.
// Read back both settings; a failed configuration must not fall through into
// transmitting at the driver's default power. This limits RF output, not the
// entire board's current consumption or PHY startup/calibration current.
inline bool configure_wifi_power(int8_t limit_qdbm, int8_t* applied_qdbm) {
    *applied_qdbm = 0;
    if (esp_wifi_set_max_tx_power(limit_qdbm) != ESP_OK) return false;

    int8_t actual_qdbm = 0;
    if (esp_wifi_get_max_tx_power(&actual_qdbm) != ESP_OK ||
        actual_qdbm < 8 || actual_qdbm > limit_qdbm) return false;

    // Use IDF directly: Arduino's setSleep() returns false when the requested
    // mode already matches its cache, which is not a configuration failure.
    if (esp_wifi_set_ps(WIFI_PS_MIN_MODEM) != ESP_OK) return false;
    wifi_ps_type_t actual_sleep = WIFI_PS_NONE;
    if (esp_wifi_get_ps(&actual_sleep) != ESP_OK ||
        actual_sleep != WIFI_PS_MIN_MODEM) return false;

    *applied_qdbm = actual_qdbm;
    return true;
}
