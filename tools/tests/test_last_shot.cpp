// Host regression tests for the last-shot chip helpers (src/system/last_shot.h).
// The chip replaced the server's finer/coarser verdict with the raw evidence -
// what the last grind delivered - so the text must stay inside the chip's
// width budget and a superseded prompt must never stamp its time onto a newer
// grind's record.

#include <cstdio>
#include <cstring>

#include "system/last_shot.h"

static int failures = 0;

#define CHECK(cond, msg)                                            \
    do {                                                            \
        if (!(cond)) {                                              \
            std::printf("FAIL: %s (%s:%d)\n", msg, __FILE__, __LINE__); \
            failures++;                                             \
        }                                                           \
    } while (0)

static void test_format_with_time() {
    char text[32];
    last_shot_format_text(text, sizeof(text), 18.2f, 28);
    CHECK(std::strcmp(text, "LAST 18.2G \xc2\xb7 28S") == 0,
          "measured shot renders as 'LAST 18.2G · 28S'");
}

static void test_format_without_time() {
    char text[32];
    last_shot_format_text(text, sizeof(text), 18.2f, 0);
    CHECK(std::strcmp(text, "LAST 18.2G") == 0,
          "unmeasured time renders weight only");
}

static void test_format_rounding_and_range() {
    char text[32];
    // %.1f rounds half away from zero on this toolchain; the chip only needs
    // a stable tenth.
    last_shot_format_text(text, sizeof(text), 17.96f, 31);
    CHECK(std::strcmp(text, "LAST 18.0G \xc2\xb7 31S") == 0,
          "dose rounds to the tenth");
    last_shot_format_text(text, sizeof(text), 7.0f, 255);
    CHECK(std::strcmp(text, "LAST 7.0G \xc2\xb7 255S") == 0,
          "the full uint16 second range renders");
    last_shot_format_text(text, sizeof(text), 123.4f, 88);
    CHECK(std::strcmp(text, "LAST 123.4G \xc2\xb7 88S") == 0,
          "a large dose still fits the buffer");
}

static void test_format_truncates_safely() {
    char tiny[8];
    last_shot_format_text(tiny, sizeof(tiny), 18.2f, 28);
    CHECK(std::strlen(tiny) < sizeof(tiny), "truncation stays in bounds");
    CHECK(tiny[sizeof(tiny) - 1] == '\0', "truncation null-terminates");
    last_shot_format_text(nullptr, 8, 1.0f, 1);
    last_shot_format_text(tiny, 0, 1.0f, 1);
}

static void test_brew_time_applies_guard() {
    CHECK(!last_shot_brew_time_applies(0, 42),
          "no stored record accepts nothing");
    CHECK(!last_shot_brew_time_applies(41, 42),
          "a superseded prompt's finish does not apply");
    CHECK(last_shot_brew_time_applies(42, 42),
          "the matching session applies");
}

int main() {
    test_format_with_time();
    test_format_without_time();
    test_format_rounding_and_range();
    test_format_truncates_safely();
    test_brew_time_applies_guard();

    if (failures) {
        std::printf("%d check(s) failed\n", failures);
        return 1;
    }
    std::printf("all last shot checks passed\n");
    return 0;
}
