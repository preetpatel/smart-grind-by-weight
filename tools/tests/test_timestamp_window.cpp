#include "hardware/circular_buffer_math/timestamp_window.h"

#include <cassert>
#include <cstdint>
#include <limits>

int main() {
    constexpr uint32_t max_time = std::numeric_limits<uint32_t>::max();

    assert(TimestampWindow::contains(50, 30, 100));
    assert(TimestampWindow::contains(50, max_time - 24, 100));
    assert(!TimestampWindow::contains(50, max_time - 100, 100));

    assert(TimestampWindow::contains(50, 50, 0));
    assert(!TimestampWindow::contains(50, 49, 0));
    assert(TimestampWindow::age(50, max_time - 24) == 75);

    return 0;
}
