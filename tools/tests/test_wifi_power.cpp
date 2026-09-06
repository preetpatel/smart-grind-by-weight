// TEST_INCLUDE_DIRS: tools/tests/support/wifi_power
// Tests the real power-configuration boundary with driver failure injection.
// These validate policy enforcement; they do not simulate supply voltage.
#include "system/wifi_power.h"
#include <cassert>
#include <cstdio>

static int call_count;
static int fail_on;
static int8_t requested_power;
static int8_t reported_power;
static wifi_ps_type_t reported_sleep;

static esp_err_t next_call() { return ++call_count == fail_on ? -1 : ESP_OK; }
esp_err_t esp_wifi_set_max_tx_power(int8_t power) {
    requested_power = power;
    return next_call();
}
esp_err_t esp_wifi_get_max_tx_power(int8_t* power) {
    *power = reported_power;
    return next_call();
}
esp_err_t esp_wifi_set_ps(wifi_ps_type_t mode) {
    assert(mode == WIFI_PS_MIN_MODEM);
    return next_call();
}
esp_err_t esp_wifi_get_ps(wifi_ps_type_t* mode) {
    *mode = reported_sleep;
    return next_call();
}

static void reset_driver() {
    call_count = 0;
    fail_on = 0;
    requested_power = 0;
    reported_power = 34;
    reported_sleep = WIFI_PS_MIN_MODEM;
}

int main() {
    // A new window must configure the driver again, even when the previous
    // window succeeded: WIFI_OFF discards the driver's power configuration.
    for (int window = 0; window < 2; ++window) {
        reset_driver();
        int8_t applied = 0;
        assert(configure_wifi_power(34, &applied));
        assert(requested_power == 34 && applied == 34 && call_count == 4);
    }

    for (int failure = 1; failure <= 4; ++failure) {
        reset_driver();
        fail_on = failure;
        int8_t applied = 34; // A stale success must not survive failure.
        assert(!configure_wifi_power(34, &applied));
        assert(applied == 0 && call_count == failure);
    }

    reset_driver();
    reported_power = 80; // Setter claims success but power is still default.
    int8_t applied = 0;
    assert(!configure_wifi_power(34, &applied));
    assert(applied == 0 && call_count == 2);

    reset_driver();
    reported_power = 28; // Driver/regulatory quantization may lower the cap.
    assert(configure_wifi_power(34, &applied) && applied == 28);

    reset_driver();
    reported_power = 0; // Reject invalid/uninitialized readback.
    assert(!configure_wifi_power(34, &applied) && applied == 0);

    reset_driver();
    reported_sleep = WIFI_PS_NONE; // Don't trust a successful setter alone.
    assert(!configure_wifi_power(34, &applied) && applied == 0);
    std::puts("Wi-Fi power policy checks passed (physical current not simulated)");
}
