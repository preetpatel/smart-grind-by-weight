#pragma once

//==============================================================================
// SYSTEM CONFIGURATION CONSTANTS
//==============================================================================
// This file contains core system configuration values that control the
// operation of the ESP32 coffee grinder's internal algorithms and timing.
// These parameters affect system behavior, task scheduling, and algorithmic
// calculations.
//
// Categories:
// - Task Scheduling Intervals (RTOS task update frequencies)
// - Algorithm Parameters (error thresholds, calculation factors)
// - System Timeouts (operation limits, safety timeouts)
// - Display Processing (filtering, formatting, update rates)
// - Logging and Debug Configuration (output intervals, buffer sizes)
//
// All constants use the SYS_ prefix to indicate system-level parameters.

// Logging system is included separately where needed

//------------------------------------------------------------------------------
// FREERTOS TASK CONFIGURATION
//------------------------------------------------------------------------------
// Critical timing for FreeRTOS task architecture with 6 specialized tasks

// Task Intervals (milliseconds)
// The weight sampling interval is also the hard ceiling on how fast the load cell buffer can be
// fed, whatever the ADC actually does. CircularBufferMath sizes its stack scratch arrays off that
// ceiling rather than HW_LOADCELL_SAMPLE_RATE_SPS, so a load cell running faster than advertised
// cannot overrun them.
#define SYS_TASK_WEIGHT_SAMPLING_INTERVAL_MS 20                                // Weight sampling poll interval (50Hz poll; HX711 @10SPS) - Core 0
#define SYS_TASK_GRIND_CONTROL_INTERVAL_MS 20                                  // Grind controller update interval (50Hz) - Core 0
#define SYS_TASK_UI_INTERVAL_MS 16                                             // UI rendering frequency (60Hz) - Core 1  
#define SYS_TASK_BLUETOOTH_INTERVAL_MS 20                                      // Bluetooth handling frequency (50Hz) - Core 1
#define SYS_TASK_FILE_IO_INTERVAL_MS 100                                       // File I/O operations frequency (10Hz) - Core 1

// Task Stack Sizes (bytes) - Increased for BLE_LOG overhead and complex operations
#define SYS_TASK_WEIGHT_SAMPLING_STACK_SIZE 4096                               // 4KB stack for weight sampling (was 2KB, increased for BLE_LOG)
#define SYS_TASK_GRIND_CONTROL_STACK_SIZE 6144                                 // 6KB stack for grind control logic (was 4KB, increased for complex algorithms)
#define SYS_TASK_UI_STACK_SIZE 8192                                            // 8KB stack for LVGL rendering (unchanged)
#define SYS_TASK_BLUETOOTH_STACK_SIZE 4096                                     // 4KB stack for BLE operations (unchanged)
#define SYS_TASK_FILE_IO_STACK_SIZE 6144                                       // 6KB stack for LittleFS operations (was 4KB, increased for file operations)

// Task Priorities (higher number = higher priority)
#define SYS_TASK_PRIORITY_WEIGHT_SAMPLING 4                                    // Highest priority (real-time sampling)
#define SYS_TASK_PRIORITY_GRIND_CONTROL 3                                      // High priority (grind control)
#define SYS_TASK_PRIORITY_UI 2                                                 // Medium priority (UI updates)
// Raise BLE above UI to prevent starvation during transfers
#define SYS_TASK_PRIORITY_BLUETOOTH 3                                          // Higher priority (BLE operations)
#define SYS_TASK_PRIORITY_FILE_IO 1                                            // Low priority (file operations)

// Inter-Task Communication Queue Sizes
#define SYS_QUEUE_UI_TO_GRIND_SIZE 5                                           // UI events to grind controller
#define SYS_QUEUE_FILE_IO_SIZE 20                                              // File I/O operation requests

// Menu status text refresh rate. Slow-moving readouts (uptime, diagnostics, BLE state) are
// decoupled from the 60Hz UI task: every label rewrite is a heap free/malloc pair in LVGL,
// so refreshing them per frame churns the shared internal heap for no visible benefit.
#define SYS_MENU_STATUS_REFRESH_INTERVAL_MS 250                                // Menu status text refresh (4Hz) - Core 1

// Legacy task scheduler intervals (deprecated - kept for compatibility)
#define SYS_TASK_LOADCELL_INTERVAL_MS 20                                       // Load cell polling frequency (50Hz)


//------------------------------------------------------------------------------
// TIME CONVERSION CONSTANTS
//------------------------------------------------------------------------------
#define SYS_MS_PER_SECOND 1000                                                 // Milliseconds per second conversion


//------------------------------------------------------------------------------
// WEIGHT DISPLAY FILTER SETTINGS
//------------------------------------------------------------------------------
// Asymmetric display filter for smooth weight updates
#define SYS_DISPLAY_FILTER_ALPHA_DOWN 0.9f                                     // Slower decay when weight decreases
#define SYS_DISPLAY_FILTER_WINDOW_MS 300                                       // Smoothing window feeding the display filter

//------------------------------------------------------------------------------
// LOAD CELL NOISE FLOOR MONITORING
//------------------------------------------------------------------------------
// Feeds the Noise Floor readout on Menu -> Diagnostics. The point of these numbers is to answer
// "how many grams does a resting scale wander by", which decides how many decimals the weight
// display can honestly show.
//
// The standard-deviation window is deliberately short: CircularBufferMath copies a window into a
// fixed 64-entry scratch array (WINDOW_SAMPLE_CAPACITY), and at HW_LOADCELL_SAMPLE_RATE_SPS=10 a
// 5000ms window asks for 60 samples - just under that ceiling. Raising the ADC sample rate would
// silently clamp this window to the newest 64 samples rather than break, which is an acceptable
// degradation. The peak-to-peak window has no such limit because get_weight_range() walks the ring
// buffer directly.
#define SYS_NOISE_STDDEV_WINDOW_MS 5000                                        // Window for single-sample standard deviation
#define SYS_NOISE_MONITOR_WINDOW_MS 30000                                      // Rolling window for peak-to-peak and display-path stats
#define SYS_NOISE_CAPTURE_DURATION_MS 30000                                    // Duration of an on-demand frozen noise capture
#define SYS_NOISE_TARGET_DISPLAY_STEP_G 0.01f                                  // Display step the "spread" verdict is measured against
#define SYS_NOISE_MIN_SAMPLES_FOR_STATS 20                                     // Samples required before display-path stats are reported

//------------------------------------------------------------------------------
// JOG ACCELERATION CONFIGURATION
//------------------------------------------------------------------------------
// Button jog/hold acceleration thresholds (when to transition between stages)
#define USER_JOG_STAGE_1_INTERVAL_MS 100                                       // Stage 1: slow jog interval
#define USER_JOG_STAGE_2_THRESHOLD_MS 2000                                     // Time to reach stage 2 acceleration
#define USER_JOG_STAGE_3_THRESHOLD_MS 4000                                     // Time to reach stage 3 acceleration
#define USER_JOG_STAGE_4_THRESHOLD_MS 6000                                     // Time to reach stage 4 acceleration

// JOG acceleration multipliers (using multipliers to overcome LVGL timer limits)
#define SYS_JOG_STAGE_1_MULTIPLIER 1                                           // Stage 1: single increment per timer tick
#define SYS_JOG_STAGE_2_INTERVAL_MS 64                                         // Stage 2: LVGL minimum timer interval
#define SYS_JOG_STAGE_2_MULTIPLIER 3                                           // Stage 2: 3 increments per 64ms = ~4.7g/s
#define SYS_JOG_STAGE_3_INTERVAL_MS 64                                         // Stage 3: LVGL minimum timer interval  
#define SYS_JOG_STAGE_3_MULTIPLIER 6                                           // Stage 3: 6 increments per 64ms = ~9.4g/s
#define SYS_JOG_STAGE_4_INTERVAL_MS 64                                         // Stage 4: LVGL minimum timer interval
#define SYS_JOG_STAGE_4_MULTIPLIER 13                                          // Stage 4: 13 increments per 64ms = ~20.3g/s

//------------------------------------------------------------------------------
// LOGGING CONFIGURATION
//------------------------------------------------------------------------------
#define SYS_LOG_EVERY_N_GRIND_LOOPS 1                                          // Log frequency for grind control loop
#define SYS_CONTINUOUS_LOGGING_ENABLED true                                    // Enable/disable continuous logging

//------------------------------------------------------------------------------
// DEBUG HEARTBEAT CONFIGURATION
//------------------------------------------------------------------------------
#define SYS_ENABLE_REALTIME_HEARTBEAT 1                                            // Enable Core 0/Core 1 heartbeat logging (0=disabled, 1=enabled)
#define SYS_REALTIME_HEARTBEAT_INTERVAL_MS 10000                                   // Heartbeat interval in milliseconds

//------------------------------------------------------------------------------
// PRINTF FORMAT STRINGS
//------------------------------------------------------------------------------
#define SYS_WEIGHT_DISPLAY_FORMAT "%.1fg"                                      // Weight display format string
#define SYS_RAW_VALUE_FORMAT "%ld"                                             // Raw load cell value format string

