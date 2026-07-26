#pragma once

#include <stdint.h>

namespace TimestampWindow {

constexpr uint32_t age(uint32_t now, uint32_t timestamp) {
    return now - timestamp;
}

constexpr bool contains(uint32_t now, uint32_t timestamp, uint32_t window_ms) {
    return age(now, timestamp) <= window_ms;
}

}  // namespace TimestampWindow
