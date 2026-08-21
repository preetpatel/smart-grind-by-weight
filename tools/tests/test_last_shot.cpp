// Host regression tests for the last-shot chip helpers (src/system/last_shot.h).
// The chip replaced the server's finer/coarser verdict with the raw evidence -
// the shot's weight out and time once logged, the dose until then - so the
// text must stay inside the chip's width budget, use only glyphs the built-in
// montserrat fonts carry, and a superseded prompt must never stamp its shot
// onto a newer grind's record.

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

// U+2022 BULLET - the only separator the montserrat fonts contain (their
// range is 0x20-0x7F, 0xB0, 0x2022; U+00B7 MIDDLE DOT drew a missing-glyph
// box on the device).
#define SEP "\xe2\x80\xa2"

static void test_format_logged_shot() {
    char text[32];
    last_shot_format_text(text, sizeof(text), 18.2f, 36.0f, 28);
    CHECK(std::strcmp(text, "LAST 36.0G " SEP " 28S") == 0,
          "a logged shot renders its weight out and time");
}

static void test_format_untimed_shot() {
    char text[32];
    last_shot_format_text(text, sizeof(text), 18.2f, 36.0f, 0);
    CHECK(std::strcmp(text, "LAST 36.0G") == 0,
          "a shot with the time step skipped renders weight out only");
}

static void test_format_dose_fallback() {
    char text[32];
    last_shot_format_text(text, sizeof(text), 18.2f, 0.0f, 0);
    CHECK(std::strcmp(text, "LAST 18.2G") == 0,
          "an unlogged shot falls back to the dose");
}

static void test_format_avoids_middle_dot() {
    char text[32];
    last_shot_format_text(text, sizeof(text), 18.2f, 36.0f, 28);
    CHECK(std::strstr(text, "\xc2\xb7") == nullptr,
          "U+00B7 is not in the montserrat fonts and must not appear");
}

static void test_format_rounding_and_range() {
    char text[32];
    // %.1f rounds half away from zero on this toolchain; the chip only needs
    // a stable tenth.
    last_shot_format_text(text, sizeof(text), 18.0f, 35.96f, 31);
    CHECK(std::strcmp(text, "LAST 36.0G " SEP " 31S") == 0,
          "weight out rounds to the tenth");
    last_shot_format_text(text, sizeof(text), 7.0f, 0.0f, 255);
    CHECK(std::strcmp(text, "LAST 7.0G " SEP " 255S") == 0,
          "the full uint16 second range renders");
    last_shot_format_text(text, sizeof(text), 18.0f, 123.4f, 88);
    CHECK(std::strcmp(text, "LAST 123.4G " SEP " 88S") == 0,
          "a large weight out still fits the buffer");
}

static void test_format_truncates_safely() {
    char tiny[8];
    last_shot_format_text(tiny, sizeof(tiny), 18.2f, 36.0f, 28);
    CHECK(std::strlen(tiny) < sizeof(tiny), "truncation stays in bounds");
    CHECK(tiny[sizeof(tiny) - 1] == '\0', "truncation null-terminates");
    last_shot_format_text(nullptr, 8, 1.0f, 1.0f, 1);
    last_shot_format_text(tiny, 0, 1.0f, 1.0f, 1);
}

static void test_brew_applies_guard() {
    CHECK(!last_shot_brew_applies(0, 42),
          "no stored record accepts nothing");
    CHECK(!last_shot_brew_applies(41, 42),
          "a superseded prompt's finish does not apply");
    CHECK(last_shot_brew_applies(42, 42),
          "the matching session applies");
}

int main() {
    test_format_logged_shot();
    test_format_untimed_shot();
    test_format_dose_fallback();
    test_format_avoids_middle_dot();
    test_format_rounding_and_range();
    test_format_truncates_safely();
    test_brew_applies_guard();

    if (failures) {
        std::printf("%d check(s) failed\n", failures);
        return 1;
    }
    std::printf("all last shot checks passed\n");
    return 0;
}
