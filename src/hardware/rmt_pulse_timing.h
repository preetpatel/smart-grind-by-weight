#pragma once

#include <stddef.h>
#include <stdint.h>

namespace RmtPulseTiming {

constexpr uint32_t MAX_PHASE_DURATION_US = 32767;
constexpr uint32_t MAX_SYMBOL_DURATION_US = MAX_PHASE_DURATION_US * 2;

struct SymbolDurations {
    uint16_t first_us;
    uint16_t second_us;
};

constexpr size_t required_symbol_count(uint64_t duration_us) {
    return duration_us == 0
        ? 0
        : static_cast<size_t>(
              (duration_us + MAX_SYMBOL_DURATION_US - 1) / MAX_SYMBOL_DURATION_US);
}

constexpr SymbolDurations symbol_durations(uint64_t duration_us, size_t symbol_index) {
    const uint64_t symbol_start_us =
        static_cast<uint64_t>(symbol_index) * MAX_SYMBOL_DURATION_US;

    if (symbol_start_us >= duration_us) {
        return {0, 0};
    }

    const uint64_t remaining_us = duration_us - symbol_start_us;
    const uint16_t first_us = static_cast<uint16_t>(
        remaining_us > MAX_PHASE_DURATION_US ? MAX_PHASE_DURATION_US : remaining_us);
    const uint64_t after_first_us = remaining_us - first_us;
    const uint16_t second_us = static_cast<uint16_t>(
        after_first_us > MAX_PHASE_DURATION_US ? MAX_PHASE_DURATION_US : after_first_us);

    return {first_us, second_us};
}

}  // namespace RmtPulseTiming
