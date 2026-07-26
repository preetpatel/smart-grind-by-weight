#include "hardware/circular_buffer_math/percentile_index.h"

#include <array>
#include <cassert>
#include <cstddef>

namespace {

template <size_t N>
float select_calibrated_percentile(
    const std::array<float, N>& sorted_raw_rates,
    float calibration_factor,
    float percentile) {
    const bool reverse_raw_order = calibration_factor < 0.0f;
    const size_t index =
        PercentileIndex::select(N, percentile, reverse_raw_order);
    return sorted_raw_rates[index] / calibration_factor;
}

}  // namespace

int main() {
    constexpr std::array<float, 5> negative_raw_rates = {
        -21000.0f,
        -17500.0f,
        -14000.0f,
        -10500.0f,
        -7000.0f,
    };
    constexpr std::array<float, 5> positive_raw_rates = {
        7000.0f,
        10500.0f,
        14000.0f,
        17500.0f,
        21000.0f,
    };

    assert(select_calibrated_percentile(
               negative_raw_rates, -7000.0f, 0.95f) == 3.0f);
    assert(select_calibrated_percentile(
               positive_raw_rates, 7000.0f, 0.95f) == 3.0f);

    for (size_t count = 1; count <= 64; ++count) {
        const size_t ascending = PercentileIndex::select(count, 0.95f, false);
        const size_t descending = PercentileIndex::select(count, 0.95f, true);
        assert(descending == count - 1 - ascending);
    }

    assert(PercentileIndex::select(0, 0.95f, false) == 0);
    assert(PercentileIndex::select(5, -1.0f, false) == 0);
    assert(PercentileIndex::select(5, 2.0f, false) == 4);

    return 0;
}
