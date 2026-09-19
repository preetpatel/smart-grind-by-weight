// TEST_INCLUDE_DIRS: tools/tests/support/hx711
// Exercise the production bit-banged driver with a simulated DOUT/SCK bus.
#include "hardware/hx711_driver.cpp"
#include "hardware/WeightSensor.cpp"
#include "hardware/circular_buffer_math/circular_buffer_math.cpp"
#include "hardware/load_cell_noise_monitor.cpp"

#include <cassert>
#include <cstdio>
#include <initializer_list>

namespace {
unsigned long now_us = 1000;
uint32_t wire_data = 0;
unsigned int pulses = 0;
bool ready = true;
bool stuck_low = false;
bool interrupts_enabled = true;
int clock_level = LOW;

void frame(uint32_t data, bool broken = false) {
    wire_data = data;
    pulses = 0;
    ready = true;
    stuck_low = broken;
    now_us += 100000;
}
} // namespace

unsigned long millis() { return now_us / 1000; }
unsigned long micros() { return now_us; }
void delay(unsigned long ms) { now_us += ms * 1000; }
void delayMicroseconds(unsigned int us) { now_us += us; }
void pinMode(uint8_t, int) {}
void noInterrupts() { interrupts_enabled = false; }
void interrupts() { interrupts_enabled = true; }
void digitalWrite(uint8_t pin, int level) {
    assert(pin == HW_LOADCELL_SCK_PIN);
    if (clock_level == LOW && level == HIGH) ++pulses;
    clock_level = level;
}
int digitalRead(uint8_t pin) {
    assert(pin == HW_LOADCELL_DOUT_PIN);
    if (stuck_low) return LOW;
    if (!ready) return HIGH;
    if (pulses == 0) return LOW;
    if (pulses > 24) return HIGH;
    return (wire_data >> (24 - pulses)) & 1;
}

int main() {
    HX711Driver driver;
    constexpr int32_t tare_raw = 9524556;
    constexpr float calibration = 6757.51f;
    frame((tare_raw + 6758) ^ 0x800000);
    assert(driver.update_async());
    const int32_t last_good = driver.get_raw_data();
    assert(last_good == tare_raw + 6758);
    assert(pulses == 25);

    // An interrupted/disconnected bus can stay LOW throughout a read. The
    // old driver accepted that as 0x800000, producing about -168.1g after
    // tare. A real HX711 must raise DOUT after the 25th clock pulse.
    frame(0, true);
    const bool accepted = driver.update_async();
    const float weight = (driver.get_raw_data() - tare_raw) / calibration;
    std::printf("Stuck-low read: accepted=%d, weight=%.1fg\n", accepted, weight);
    std::fflush(stdout);
    assert(!accepted);
    assert(driver.get_raw_data() == last_good);
    assert(interrupts_enabled && clock_level == LOW);

    // Recover on the next valid frame without re-taring or changing gain.
    frame((tare_raw + 13515) ^ 0x800000);
    assert(driver.update_async());
    assert(driver.get_raw_data() == tare_raw + 13515);

    // Zero, -1 and saturation are real ADC codes. Do not reject them based
    // on their value; it is the bus handshake that distinguishes a fault.
    for (uint32_t data : {0U, 0xFFFFFFU, 0x800000U, 0x7FFFFFU}) {
        frame(data);
        assert(driver.update_async());
        assert(driver.get_raw_data() == static_cast<int32_t>(data ^ 0x800000));
    }

    for (uint8_t gain : {32, 64, 128}) {
        driver.set_gain(gain);
        frame(0x123456);
        assert(driver.update_async());
        assert(pulses == (gain == 32 ? 26U : gain == 64 ? 27U : 25U));
        assert(driver.get_current_gain() == gain);
    }

    const int32_t before_not_ready = driver.get_raw_data();
    frame(0);
    ready = false;
    assert(!driver.update_async());
    assert(pulses == 0);
    assert(driver.get_raw_data() == before_not_ready);

    // Exercise the actual sampling path across tare -> purge -> motor
    // restart. Rejecting a frame at the driver is insufficient if the
    // sampling task feeds the previous ADC value back as a fresh sample.
    WeightSensor sensor;
    sensor.init(nullptr);
    assert(sensor.ms_since_last_sample() == UINT32_MAX);
    sensor.set_calibration_factor(calibration);
    sensor.start_nonblocking_tare();
    for (int i = 0; i < 25; ++i) {
        frame(tare_raw ^ 0x800000);
        assert(sensor.sample_and_feed_filter());
    }
    assert(!sensor.is_tare_in_progress());
    assert(sensor.get_zero_offset() == tare_raw);
    assert(sensor.get_weight_low_latency() == 0.0f);
    for (int i = 0; i < 10; ++i) {
        frame((tare_raw + 8623) ^ 0x800000); // ~1.28g of purge grounds
        assert(sensor.sample_and_feed_filter());
    }
    const int samples_before_fault = sensor.get_sample_count();
    assert(sensor.ms_since_last_sample() == 0);
    for (int i = 0; i < 5; ++i) {
        frame(0, true);
        const bool fed = sensor.sample_and_feed_filter();
        std::printf("Broken frame fed to filter: %d\n", fed);
        std::fflush(stdout);
        assert(!fed);
        assert(sensor.get_sample_count() == samples_before_fault);
        assert(sensor.get_zero_offset() == tare_raw);
        assert(sensor.get_weight_low_latency() > 1.0f);
    }
    // Rejected frames age the last accepted sample; that age is what the grind
    // controller's stale-sample failsafe watches (GRIND_SCALE_STALE_SAMPLE_TIMEOUT_MS).
    assert(sensor.ms_since_last_sample() == 5 * 100);
    for (int i = 0; i < 10; ++i) {
        frame((tare_raw + 13515) ^ 0x800000); // valid grinding resumes at ~2g
        assert(sensor.sample_and_feed_filter());
    }
    assert(sensor.ms_since_last_sample() == 0);
    assert(std::fabs(sensor.get_weight_low_latency() - 2.0f) < 0.01f);
    // Real cup removal still reaches the controller's negative-weight cutoff.
    for (int i = 0; i < 10; ++i) {
        frame((tare_raw - 675751) ^ 0x800000);
        assert(sensor.sample_and_feed_filter());
    }
    assert(sensor.get_weight_low_latency() < -99.0f);
}
