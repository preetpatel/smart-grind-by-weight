#pragma once
// Stub of the detools apply entry points referenced by delta.c. The staging
// tests never apply a patch; returning an error keeps accidental calls loud.

#include <stddef.h>
#include <stdint.h>

static inline int detools_apply_patch_callbacks(int (*read_src)(void*, uint8_t*, size_t),
                                                int (*seek_src)(void*, int),
                                                int (*read_patch)(void*, uint8_t*, size_t),
                                                size_t patch_size,
                                                int (*write_dest)(void*, const uint8_t*, size_t),
                                                void* arg) {
    (void)read_src; (void)seek_src; (void)read_patch;
    (void)patch_size; (void)write_dest; (void)arg;
    return -1;
}

static inline const char* detools_error_as_string(int error) {
    (void)error;
    return "detools stub";
}
