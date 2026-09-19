#pragma once

// These tests use explicit calibration and do not persist settings.
class Preferences {
public:
    bool begin(const char*, bool = false) { return true; }
    void end() {}
    bool isKey(const char*) { return false; }
    bool remove(const char*) { return true; }
    float getFloat(const char*, float value = 0) { return value; }
    bool getBool(const char*, bool value = false) { return value; }
    void putFloat(const char*, float) {}
    void putBool(const char*, bool) {}
};
