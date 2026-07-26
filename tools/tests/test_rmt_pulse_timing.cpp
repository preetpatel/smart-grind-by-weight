#include "hardware/rmt_pulse_timing.h"

#include <cassert>
#include <cstddef>
#include <cstdint>

namespace {

uint64_t encoded_high_time_us(uint64_t requested_us) {
    uint64_t encoded_us = 0;
    const size_t symbol_count = RmtPulseTiming::required_symbol_count(requested_us);

    for (size_t index = 0; index < symbol_count; ++index) {
        const RmtPulseTiming::SymbolDurations durations =
            RmtPulseTiming::symbol_durations(requested_us, index);
        encoded_us += durations.first_us;
        encoded_us += durations.second_us;
    }

    return encoded_us;
}

}  // namespace

int main() {
    constexpr uint64_t boundary_cases_us[] = {
        0,
        1,
        32767,
        32768,
        65534,
        65535,
        100000,
        300000,
        550000,
        1000000,
    };

    for (uint64_t requested_us : boundary_cases_us) {
        assert(encoded_high_time_us(requested_us) == requested_us);
    }

    // Exhaustively cover every microsecond across the currently supported
    // one-second pulse range.
    for (uint64_t requested_us = 0; requested_us <= 1000000; ++requested_us) {
        assert(encoded_high_time_us(requested_us) == requested_us);
    }

    assert(RmtPulseTiming::required_symbol_count(0) == 0);
    assert(RmtPulseTiming::required_symbol_count(1) == 1);
    assert(RmtPulseTiming::required_symbol_count(65534) == 1);
    assert(RmtPulseTiming::required_symbol_count(65535) == 2);
    assert(RmtPulseTiming::required_symbol_count(1000000) == 16);

    return 0;
}
