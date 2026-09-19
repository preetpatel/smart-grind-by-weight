#pragma once

#include <cstdint>
#include <cmath>
#include <cstring>
#include <algorithm>
using std::min;
using std::max;

constexpr int LOW = 0;
constexpr int HIGH = 1;
constexpr int OUTPUT = 1;
constexpr int INPUT_PULLDOWN = 2;

unsigned long millis();
unsigned long micros();
void delay(unsigned long ms);
void delayMicroseconds(unsigned int us);
void pinMode(uint8_t pin, int mode);
void digitalWrite(uint8_t pin, int level);
int digitalRead(uint8_t pin);
void noInterrupts();
void interrupts();

struct TestSerial {
    template <typename... Args>
    void printf(const char*, Args...) {}
};
inline TestSerial Serial;
