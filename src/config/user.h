#pragma once

//==============================================================================
// USER CONFIGURATION PARAMETERS
//==============================================================================
// This file contains user-configurable parameters that affect coffee grinding
// behavior, UI responsiveness, and device operation. These are the primary
// settings that users might want to modify to customize their grinder.

//------------------------------------------------------------------------------
// COFFEE PROFILES
//------------------------------------------------------------------------------
#define USER_PROFILE_COUNT 3                                                   // Number of coffee profiles available
#define USER_PROFILE_NAME_MAX_LENGTH 8                                         // Maximum characters in profile name

// Default target weights for each profile
#define USER_SINGLE_ESPRESSO_WEIGHT_G 9.0f                                     // Single espresso default weight
#define USER_DOUBLE_ESPRESSO_WEIGHT_G 18.0f                                    // Double espresso default weight  
#define USER_CUSTOM_PROFILE_WEIGHT_G 21.5f                                     // Custom profile default weight

#define USER_SINGLE_ESPRESSO_TIME_S 5.0f                                       // Single espresso default grind time
#define USER_DOUBLE_ESPRESSO_TIME_S 10.0f                                      // Double espresso default grind time
#define USER_CUSTOM_PROFILE_TIME_S 12.0f                                       // Custom profile default grind time

// Weight limits
#define USER_MIN_TARGET_WEIGHT_G 5.0f                                          // Minimum allowed target weight
#define USER_MAX_TARGET_WEIGHT_G 1000.0f                                        // Maximum allowed target weight

#define USER_MIN_TARGET_TIME_S 0.1f                                            // Minimum allowed target time
#define USER_MAX_TARGET_TIME_S 25.0f                                           // Maximum allowed target time

//------------------------------------------------------------------------------
// WEIGHT/TIME ADJUSTMENTS
//------------------------------------------------------------------------------
#define USER_FINE_WEIGHT_ADJUSTMENT_G 0.1f                                     // Small weight increment for fine tuning
#define USER_FINE_TIME_ADJUSTMENT_S 0.1f                                       // Fine adjustment step for time editing

// USER_JOG parameters moved to system.h to be near SYS_JOG parameters

//------------------------------------------------------------------------------
// SCALE CALIBRATION
//------------------------------------------------------------------------------
#define USER_CALIBRATION_REFERENCE_WEIGHT_G 100.0f                             // Default reference weight for calibration
#define USER_DEFAULT_CALIBRATION_FACTOR -7050.0f                               // Default load cell calibration factor

//------------------------------------------------------------------------------
// SCREEN AUTO-DIMMING
//------------------------------------------------------------------------------
#define USER_SCREEN_AUTO_DIM_TIMEOUT_MS 300000                                 // Idle time before the screensaver starts (clock face, or dimming when the face is off)
#define USER_SCREEN_BRIGHTNESS_NORMAL 1.0f                                     // Normal screen brightness
#define USER_SCREEN_BRIGHTNESS_DIMMED 0.35f                                    // Dimmed screen brightness

//------------------------------------------------------------------------------
// IDLE CLOCK FACE
//------------------------------------------------------------------------------
// After USER_SCREEN_AUTO_DIM_TIMEOUT_MS the screen becomes a clock so the grinder
// is glanceable from across the kitchen; the backlight drops one stage later. A
// near-black face at full brightness lights far fewer AMOLED pixels than the
// normal UI dimmed, so arriving bright costs nothing.
#define USER_IDLE_CLOCK_DIM_DELAY_MS 300000                                    // Extra idle time after the clock appears before the backlight dims
#define USER_IDLE_WAKE_WEIGHT_THRESHOLD_G 0.5f                                 // Weight movement that counts as someone being there (grams)
#define USER_IDLE_WAKE_WEIGHT_WINDOW_MS 1500                                   // Window that movement is measured over - short enough that thermal drift cannot trip it
#define USER_IDLE_CLOCK_SHIFT_PX 8                                             // Pixel-shift radius applied to the face (AMOLED burn-in mitigation)
#define USER_IDLE_CLOCK_SHIFT_INTERVAL_MS 60000                                // How often the face moves to its next position

//------------------------------------------------------------------------------
// AUTO ACTIONS
//------------------------------------------------------------------------------
#define USER_AUTO_GRIND_TRIGGER_DELTA_G 50.0f                                   // Weight change threshold used for auto actions (grams)
#define USER_AUTO_GRIND_TRIGGER_WINDOW_MS 5000                                  // Time window for delta detection (milliseconds)
#define USER_AUTO_GRIND_TRIGGER_SETTLING_MS 1000                                // Settling period after trigger detection before confirmation (milliseconds)
#define USER_AUTO_GRIND_REARM_DELAY_MS 1500                                     // Minimum delay between auto actions (milliseconds)

//------------------------------------------------------------------------------
// ACTIVE BEAN / BREW ENTRY
//------------------------------------------------------------------------------
// The dashboard pushes the active bag's {name, ratio, shot time} over BLE (or
// the grinder fetches it during a cloud sync window). While one is set, every
// logged grind is followed by the brew entry screen: expected output pre-set
// to dose x ratio, jog to the actual yield, Done queues a brew record.
#define USER_BEAN_NAME_MAX_LENGTH 32                                            // Maximum characters in the active bean name
#define USER_BREW_ENTRY_TIMEOUT_MS 900000                                       // Brew entry screen holds this long (15 min) before giving up unrecorded
#define USER_BREW_OUTPUT_MAX_G 500.0f                                           // Upper clamp for the entered shot yield
#define USER_BREW_ON_TARGET_BAND_PCT 3.0f                                       // Deviation within this band shows as on-target (green)
