#pragma once

#include <stddef.h>

namespace PercentileIndex {

inline size_t select(size_t count, float percentile, bool reverse_order) {
    if (count == 0) {
        return 0;
    }

    if (!(percentile >= 0.0f)) {
        percentile = 0.0f;
    } else if (percentile > 1.0f) {
        percentile = 1.0f;
    }

    size_t index = static_cast<size_t>(count * percentile);
    if (index >= count) {
        index = count - 1;
    }

    return reverse_order ? count - 1 - index : index;
}

}  // namespace PercentileIndex
