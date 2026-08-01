// Host regression tests for the OTA patch staging path in
// components/delta/delta.c - the code every BLE firmware update flows
// through. Compiles the real delta.c against the in-memory partition fake in
// tools/tests/support/ (which enforces NOR erase-before-write semantics), so
// the PSRAM-deferred mode, the streaming fallback, the unbuffered fallback,
// bounds checks, and the CRC-32 verification all run exactly as on-device.

#include <cstdio>
#include <cstring>
#include <vector>

#include "../../components/delta/delta.c"  // real implementation + support/ stubs

static int failures = 0;

#define CHECK(cond, msg)                                                \
    do {                                                                \
        if (!(cond)) {                                                  \
            std::printf("FAIL: %s (%s:%d)\n", msg, __FILE__, __LINE__); \
            failures++;                                                 \
        }                                                               \
    } while (0)

// 0..255 repeating; awkward chunk sizes exercise batching boundaries.
static std::vector<unsigned char> make_pattern(int size) {
    std::vector<unsigned char> data(size);
    for (int i = 0; i < size; i++) data[i] = (unsigned char)(i & 0xFF);
    return data;
}

static int feed_in_chunks(delta_partition_writer_t* writer,
                          const std::vector<unsigned char>& data, int chunk) {
    for (size_t off = 0; off < data.size(); off += chunk) {
        int n = (int)((data.size() - off < (size_t)chunk) ? data.size() - off : chunk);
        int err = delta_partition_write(writer, (const char*)data.data() + off, n);
        if (err != ESP_OK) return err;
    }
    return ESP_OK;
}

static void test_crc32_vectors() {
    // Expected values computed with Python's zlib.crc32
    CHECK(delta_crc32(0, "123456789", 9) == 0xCBF43926u, "crc32 check value");
    CHECK(delta_crc32(0, "", 0) == 0x0u, "crc32 of empty input");
    CHECK(delta_crc32(0, "hello world", 11) == 0x0D4A1185u, "crc32 hello world");

    // Chaining must equal one-shot (the device hashes flash in 4KB chunks)
    const char* s = "123456789";
    uint32_t chained = delta_crc32(delta_crc32(0, s, 4), s + 4, 5);
    CHECK(chained == 0xCBF43926u, "crc32 chaining equals one-shot");
}

static void test_deferred_mode_stages_everything_in_ram() {
    fake_partition_reset();
    g_fail_spiram_alloc = 0;
    g_fail_internal_alloc = 0;

    const int size = 10496;  // matches the python-precomputed vector below
    auto data = make_pattern(size);

    delta_partition_writer_t writer = {};
    CHECK(delta_partition_init(&writer, "patch", size) == ESP_OK, "deferred init");
    CHECK(writer.deferred == 1, "PSRAM staging active");

    CHECK(feed_in_chunks(&writer, data, 509) == ESP_OK, "deferred writes accepted");
    CHECK(g_partition_write_calls == 0, "no flash writes during transfer");
    CHECK(g_partition_erase_calls == 0, "no flash erase during transfer");

    CHECK(delta_partition_flush(&writer) == ESP_OK, "deferred flush");
    CHECK(g_partition_erase_calls > 0, "flush erases before writing");
    CHECK(memcmp(g_fake_patch_storage, data.data(), size) == 0, "flash matches input after flush");

    CHECK(delta_partition_verify_crc32(&writer, size, 0x2A57C8DBu) == DELTA_OK,
          "crc32 verification matches zlib");
    CHECK(delta_partition_verify_crc32(&writer, size, 0x2A57C8DBu ^ 0xDEADBEEFu) ==
              -DELTA_PATCH_CHECKSUM_ERROR,
          "corrupted crc32 is rejected");

    delta_partition_deinit(&writer);
    delta_partition_deinit(&writer);  // idempotent
}

static void test_streaming_fallback_matches() {
    fake_partition_reset();
    g_fail_spiram_alloc = 1;  // force the 16KB streaming fallback
    g_fail_internal_alloc = 0;

    const int size = 50000;  // > 3 batches
    auto data = make_pattern(size);

    delta_partition_writer_t writer = {};
    CHECK(delta_partition_init(&writer, "patch", size) == ESP_OK, "fallback init");
    CHECK(writer.deferred == 0, "streaming fallback active");
    CHECK(g_partition_erase_calls > 0, "fallback erases up front");

    CHECK(feed_in_chunks(&writer, data, 512) == ESP_OK, "fallback writes accepted");
    CHECK(g_partition_write_calls >= 3, "fallback batches to flash during transfer");

    CHECK(delta_partition_flush(&writer) == ESP_OK, "fallback flush of the tail");
    CHECK(memcmp(g_fake_patch_storage, data.data(), size) == 0, "flash matches input");

    uint32_t expected = delta_crc32(0, data.data(), size);
    CHECK(delta_partition_verify_crc32(&writer, size, expected) == DELTA_OK, "fallback crc32 verifies");

    delta_partition_deinit(&writer);
    g_fail_spiram_alloc = 0;
}

static void test_unbuffered_last_resort_matches() {
    fake_partition_reset();
    g_fail_spiram_alloc = 1;
    g_fail_internal_alloc = 1;  // even the 16KB batch buffer fails

    const int size = 4096;
    auto data = make_pattern(size);

    delta_partition_writer_t writer = {};
    CHECK(delta_partition_init(&writer, "patch", size) == ESP_OK, "unbuffered init");
    CHECK(writer.deferred == 0 && writer.buf_cap == 0, "unbuffered mode active");

    // Internal allocs must be re-enabled for the CRC scratch buffer
    g_fail_internal_alloc = 0;

    CHECK(feed_in_chunks(&writer, data, 512) == ESP_OK, "unbuffered writes accepted");
    CHECK(delta_partition_flush(&writer) == ESP_OK, "unbuffered flush is a no-op");
    CHECK(memcmp(g_fake_patch_storage, data.data(), size) == 0, "flash matches input");

    uint32_t expected = delta_crc32(0, data.data(), size);
    CHECK(delta_partition_verify_crc32(&writer, size, expected) == DELTA_OK, "unbuffered crc32 verifies");

    delta_partition_deinit(&writer);
    g_fail_spiram_alloc = 0;
}

static void test_bounds_are_enforced() {
    fake_partition_reset();
    const int size = 1000;
    auto data = make_pattern(size + 1);

    delta_partition_writer_t writer = {};
    CHECK(delta_partition_init(&writer, "patch", size) == ESP_OK, "bounds init");
    CHECK(delta_partition_write(&writer, (const char*)data.data(), size + 1) ==
              -DELTA_OUT_OF_BOUNDS_ERROR,
          "oversized write rejected");

    CHECK(delta_partition_write(&writer, (const char*)data.data(), size) == ESP_OK, "exact fit ok");
    CHECK(delta_partition_write(&writer, (const char*)data.data(), 1) ==
              -DELTA_OUT_OF_BOUNDS_ERROR,
          "write past declared size rejected");

    delta_partition_deinit(&writer);
}

static void test_flash_write_failure_propagates() {
    fake_partition_reset();
    const int size = 8192;
    auto data = make_pattern(size);

    delta_partition_writer_t writer = {};
    CHECK(delta_partition_init(&writer, "patch", size) == ESP_OK, "failure-path init");
    CHECK(writer.deferred == 1, "deferred mode for failure test");
    CHECK(feed_in_chunks(&writer, data, 512) == ESP_OK, "writes staged");

    g_fail_write_after = 2;  // erase happens first, then the second write op dies
    CHECK(delta_partition_flush(&writer) != ESP_OK, "flush surfaces flash write failure");

    delta_partition_deinit(&writer);
}

static void test_reinit_without_deinit_is_safe() {
    fake_partition_reset();
    delta_partition_writer_t writer = {};
    CHECK(delta_partition_init(&writer, "patch", 2048) == ESP_OK, "first init");
    auto data = make_pattern(2048);
    CHECK(feed_in_chunks(&writer, data, 512) == ESP_OK, "first transfer staged");

    // A second START without END (client retried) re-inits the writer
    CHECK(delta_partition_init(&writer, "patch", 4096) == ESP_OK, "re-init");
    CHECK(writer.buf_fill == 0 && writer.offset == 0, "re-init resets staging state");

    auto data2 = make_pattern(4096);
    CHECK(feed_in_chunks(&writer, data2, 512) == ESP_OK, "second transfer staged");
    CHECK(delta_partition_flush(&writer) == ESP_OK, "second transfer flushes");
    CHECK(memcmp(g_fake_patch_storage, data2.data(), 4096) == 0, "second transfer lands");

    delta_partition_deinit(&writer);
}

int main() {
    test_crc32_vectors();
    test_deferred_mode_stages_everything_in_ram();
    test_streaming_fallback_matches();
    test_unbuffered_last_resort_matches();
    test_bounds_are_enforced();
    test_flash_write_failure_propagates();
    test_reinit_without_deinit_is_safe();

    if (failures) {
        std::printf("%d check(s) failed\n", failures);
        return 1;
    }
    std::printf("all delta staging checks passed\n");
    return 0;
}
