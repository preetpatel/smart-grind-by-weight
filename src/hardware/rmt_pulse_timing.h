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

// Splits a pulse into RMT symbol halves whose durations sum exactly to duration_us.
//
// The time is spread as evenly as possible across the symbols, and then across the two
// halves within each symbol, rather than packing each symbol to its maximum and leaving a
// short residue at the end. Even spreading keeps every emitted half non-zero for any pulse
// of at least 2us, so the transmitter is stopped by the end-of-transmission marker the RMT
// driver appends (honouring the configured eot_level) instead of by a zero-duration entry
// inside our own payload - packing would leave a 1us tail for lengths such as 65535us.
constexpr SymbolDurations symbol_durations(uint64_t duration_us, size_t symbol_index) {
    const size_t symbol_count = required_symbol_count(duration_us);

    if (symbol_index >= symbol_count) {
        return {0, 0};
    }

    // The first `extra_us` symbols absorb the indivisible remainder, one microsecond each.
    const uint64_t base_us = duration_us / symbol_count;
    const uint64_t extra_us = duration_us % symbol_count;
    const uint64_t symbol_us = base_us + (symbol_index < extra_us ? 1 : 0);

    return {static_cast<uint16_t>((symbol_us + 1) / 2),
            static_cast<uint16_t>(symbol_us / 2)};
}

}  // namespace RmtPulseTiming
