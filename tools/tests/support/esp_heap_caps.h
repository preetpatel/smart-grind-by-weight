#pragma once
#include <stdlib.h>
#define MALLOC_CAP_INTERNAL (1 << 0)
#define MALLOC_CAP_SPIRAM   (1 << 1)
#define MALLOC_CAP_8BIT     (1 << 2)
// Test hooks: force allocation failures per capability class.
static int g_fail_spiram_alloc = 0;
static int g_fail_internal_alloc = 0;
static inline void* heap_caps_malloc(size_t size, unsigned caps) {
    if ((caps & MALLOC_CAP_SPIRAM) && g_fail_spiram_alloc) return NULL;
    if ((caps & MALLOC_CAP_INTERNAL) && g_fail_internal_alloc) return NULL;
    return malloc(size);
}
