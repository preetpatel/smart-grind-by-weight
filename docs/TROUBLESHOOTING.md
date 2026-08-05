# Troubleshooting Guide

## Table of Contents

- [Motor Does Not Start](#motor-does-not-start)
- [HX711 Not Detected / Wrong Sample Rate](#hx711-not-detected--wrong-sample-rate)
- [Unknown board ID 'esp32-s3-devkitc-1'](#unknown-board-id-esp32-s3-devkitc-1)
- [PlatformIO Project Initialization Issues](#platformio-project-initialization-issues)
- [Grind Timeout Screen](#grind-timeout-screen)
- [Unreliable Pulse Corrections](#unreliable-pulse-corrections)
- [Unexplained Reboots](#unexplained-reboots)
- [Getting Diagnostic Reports](#getting-diagnostic-reports)

---

## Motor Does Not Start

**Applies to:** Eureka Mignon installations where the grinder motor does not activate when commanded.

### Symptoms
- Motor test function (Menu → Motor Test) does not start the motor
- GRIND button does not start the motor
- All other functionality works normally (screen, weight readings, etc.)

**Note:** If you hear a click and humming sound but no coffee grounds come out, the motor **is** starting correctly - your grinder is clogged, not a wiring issue.

### Root Cause
The motor control wire (Pin 3) and button signal wire (Pin 2) from the Eureka 4-pin plug may be reversed on the Waveshare board connection. The button signal wire does not control the motor.

### Diagnosis

**Option 1: Use Motor Test Function (Recommended)**

Access **Menu → Motor Test** (Tools section) to verify motor connectivity. This button activates the motor for a short test pulse. If the motor does not run during the test, the motor wire is incorrectly connected.

**Option 2: Manual Wire Identification (Advanced - Use with Extreme Caution)**

⚠️ **DANGER:** This test involves live wires and can cause the grinder to start unexpectedly, potentially causing injury or damage. Only attempt if comfortable working with electrical systems.

Using the 4-pin Eureka plug pinout (see `../media/4-pin_Eureka_plug_pinout.png` in documentation):
- **Pin 1**: 5V power supply
- **Pin 2**: Button signal (unused in this project)
- **Pin 3**: Motor control signal *(active-high — motor engages when driven to 3.3-5V)*
- **Pin 4**: Ground

The motor control wire (Pin 3) is the wire that **starts the motor when briefly driven HIGH (touch it to Pin 1 / 5V)**. Test carefully:
1. Ensure grinder is powered and hopper has minimal beans
2. Disconnect the suspect wire from the Waveshare board
3. Briefly touch the wire to 5V (Pin 1) - motor should start
4. **Be prepared for the powerful motor to cause the grinder to twist/jump**
5. **Avoid shorts that could damage the board or cause injury**

### Resolution

**Swap the wire connections:**
- The motor control wire (Pin 3) should connect to Waveshare **GPIO 18**
- The button signal wire (Pin 2) can remain disconnected (unused in this project)

If wires were reversed, swap them so Pin 3 connects to GPIO 18. The Waveshare board has reverse polarity protection for power connections, but the motor/button wires should be correctly identified for proper operation.

**Important:** Wire colors vary significantly between Eureka units - always refer to pin positions rather than wire colors when troubleshooting.

---

## HX711 Not Detected / Wrong Sample Rate

**Applies to:** First-boot issues when the load cell board is missing, miswired, or strapped for 80 SPS.

### Symptoms
- Startup log shows `HX711_NOT_CONNECTED` or `HX711_SAMPLE_RATE_INVALID`.
- Weight display stays at `0.00 g`; grinding and calibration remain disabled.

### Quick Fixes
- **NOT_CONNECTED:** Verify VCC/GND/SCK/DOUT wiring and that the HX711 board is powered.
- **SAMPLE_RATE_INVALID:** Ensure the HX711 `RATE` pin is tied to GND for 10 SPS; a floating/high pin forces 80 SPS and will now block startup.
- After correcting hardware, reboot the scale. The diagnostic clears automatically when healthy samples are detected.

## Load Cell Signal Saturated

**Applies to:** HX711 communicates but the reading is pegged at a rail (raw ADC 16777215 or 0).

### Symptoms
- Warning icon (⚠) with message "Load cell signal saturated. Check A+/A- signal wiring."
- Raw ADC reading stuck at 16777215 (0xFFFFFF) or 0, unchanged when pressing on the load cell.
- The grind button does nothing in weight mode - grinds are refused while the diagnostic is active because there is no usable weight feedback. Time mode still grinds normally.

### Root Cause
The HX711 amplifier input is railed - the differential signal exceeds the ±20mV input range at gain 128. This is an electrical fault, not a firmware or calibration issue.

### Quick Fixes
- **Broken/disconnected signal wire:** Check continuity of the A+ and A- (green/white) wires from load cell to HX711.
- **Swapped wires:** Verify excitation (E+/E-, typically red/black) and signal (A+/A-, typically green/white) wires are not crossed. Measure A+ to A-: it should read single-digit millivolts, not volts.
- **Damaged load cell:** With correct wiring, A+ to A- should change by a few mV when load is applied. If it stays railed, replace the cell.
- The diagnostic clears automatically once healthy readings return.

## Unknown board ID 'esp32-s3-devkitc-1'

**Applies to:** Windows development environments using PlatformIO with ESP32-S3 boards.

### Symptoms
- `platformio run` fails with `UnknownBoard: Unknown board ID 'esp32-s3-devkitc-1'`.
- `pio boards espressif32 | findstr "esp32-s3"` shows the board, suggesting it exists in the registry.

### Root Cause
The local PlatformIO `espressif32` platform package was pinned to an older release (e.g. 3.1.0 from 2021) that predates ESP32-S3 board definitions. The registry lookup reports current boards, but the outdated local package lacks the corresponding JSON definition.

### Resolution
1. Update the global `espressif32` platform package so it includes ESP32-S3 board definitions:
   ```powershell
   C:\Users\<user>\.platformio\penv\Scripts\platformio.exe pkg install -g -p platformio/espressif32@^6.8.0
   ```
   *(Alternatively, run `pio platform update espressif32`.)*
2. Re-run the build:
   ```powershell
   C:\Users\<user>\.platformio\penv\Scripts\platformio.exe run
   ```
3. Optional: Pin the desired platform version in `platformio.ini` to ensure consistency across machines:
   ```ini
   [env:waveshare-esp32s3-touch-amoled-164]
   platform = platformio/espressif32@^6.8.0
   ```

### Notes
- The warning `Ignore unknown configuration option 'monitor_options'` also disappears once PlatformIO core and platform packages are current.
- If multiple PlatformIO installations are present, ensure you are updating the instance used for the project.

---

## PlatformIO Project Initialization Issues

**Applies to:** General PlatformIO project setup issues, especially when using PlatformIO (as this project uses the pioarduino fork as a platform).

### Symptoms
- `Error: Could not find one of 'package.json' manifest files in the package`
- PlatformIO fails to initialize the project properly
- Vague platform-related errors during project setup

### Root Cause
The use of the pioarduino platform fork can sometimes cause PlatformIO's cache or project state to become inconsistent, leading to initialization failures.

### Resolution
1. **Close VS Code completely**
2. **Delete the PlatformIO cache folder:**
   ```bash
   # On Windows
   rmdir /s "%USERPROFILE%\.platformio"
   
   # On macOS/Linux  
   rm -rf ~/.platformio
   ```
3. **Restart VS Code**
4. **Reopen the project** - PlatformIO will reinitialize and download the correct platform packages
5. **Perform a clean build** - Use PlatformIO's "Clean" then "Build" to ensure a fresh compilation

### Alternative (Less Nuclear)
If you want to try a less aggressive approach first:
1. Close VS Code
2. Delete only the platforms cache: `~/.platformio/platforms/` (or `%USERPROFILE%\.platformio\platforms\` on Windows)
3. Restart VS Code and reopen project
4. Perform a clean build in PlatformIO

**Note:** This issue is specific to the pioarduino platform fork usage and the way PlatformIO handles custom platform URLs.

---

## Grind Timeout Screen

**Applies to:** Grinder timing out during operation, showing timeout screen after 30 seconds.

### Symptoms
- Grinder reaches timeout screen during grinding cycle
- Long taring process (>10 seconds)
- Unstable weight readings

### Root Cause
Extended taring due to load cell noise prevents grinding from completing within 30-second limit.

### Diagnosis
Check **Menu → Diagnostics → "Noise Floor"** section (see [Diagnostics System](DOC.md#diagnostics-system) for details). If "Noise level: Too High" (red text) appears persistently, your load cell has sustained noise issues that will cause slow taring (>2 seconds). A warning icon (⚠) will appear in the top-right corner when sustained noise is detected.

### Resolution
1. **Check load cell wiring:**
   - Verify shielding wire connection per wiring diagram
   - Shorten load cell cables if possible
   - Ensure clean, solid connections

2. **Check calibration factor (reference examples only):**

   Calibration factors vary between individual load cells, but extreme deviations may indicate hardware issues. Check your calibration factor in **Menu → Diagnostics → Load Cell Status**. Example values from tested units:
   - **1KG T70 load cell**: ±4400 (example)
   - **0.3KG Mavin Load Cell**: ±6580 (example)

   **Note:** These are examples only and can differ significantly between load cells. Use them as rough reference points, not expected values.

3. **If wiring issues persist:**
   - Increase `GRIND_SCALE_SETTLING_TOLERANCE_G` parameter for more noise tolerance

---

## Unreliable Pulse Corrections

**Applies to:** Pulse corrections failing to produce grounds consistently, requiring multiple correction cycles.

### Symptoms
- Multiple pulse attempts needed to reach target weight
- Inconsistent grounds production during pulse phase
- Overshooting or undershooting target weight frequently

### Root Cause
Motor response latency mismatch between firmware settings and actual hardware characteristics. Default 50ms may not match your specific grinder's relay type (solid-state vs mechanical), voltage (110V vs 220V), or burr inertia.

### Resolution

**Recommended:** Use the Auto-Tune Motor Response feature to automatically calibrate optimal pulse duration for your hardware:

1. **Access auto-tune**: Menu → Tune Pulses (Tools section)
2. **Prepare system**:
   - Ensure beans are in hopper
   - Place dosing cup on scale
   - System will automatically tare
3. **Run calibration**: Process takes 1-2 minutes
   - Priming phase: 500ms pulse to position beans
   - Binary search: Finds minimum reliable pulse duration
   - Verification: Confirms 80%+ success rate across 5 test pulses
4. **Check result**: New motor latency value displayed on completion
   - Typical range: 30-200ms depending on hardware
   - Value saved automatically to device preferences
   - Displayed in **Menu → Diagnostics**

**Verify calibration**: Check **Menu → Diagnostics → Motor Latency** to see current value. Re-run auto-tune if you change grinders, modify relay hardware, or continue experiencing unreliable pulse corrections.

**Manual fallback:** If auto-tune fails, system reverts to safe 50ms default. Check grinder power connection, hopper bean level, and scale setup.

---

## Unexplained Reboots

**Applies to:** The screen blanks and the grinder restarts on its own, with or without a noise from the grinder.

### Diagnosis

Pull a diagnostic report and read `[BOOT HISTORY]`. It records the last 8 boots and what the device was doing when each one ended:

```
[BOOT HISTORY]
  This boot started with: BROWNOUT
  Previous boot died in: BREW_ENTRY / grind IDLE / cloud sync session upload
    after 94s up, 9224 B internal free (8468 B min), build #100501
  2026-08-06 07:52:55  #100501  BROWNOUT   ran 0h 08m 46s (this boot)
  2026-08-04 17:49:22  #100501  SW         ran 38h 03m 33s
```

The reset kind is the fork in the road:

| Kind | Meaning |
|---|---|
| `BROWNOUT` | The supply sagged below the detector threshold. A power problem, not firmware. |
| `PANIC` | The firmware hit an exception. |
| `TASK_WDT` / `INT_WDT` / `WDT` | A task stopped feeding its watchdog. |
| `SW` | A deliberate restart — an OTA update, or a boot-guard rollback. |
| `POWER_ON` | Cold start. On a grinder nobody unplugged, a sag deep enough to drop the RTC domain reads this way. |
| `EXT_PIN` | The reset pin was pulled. |

The `Previous boot died in` line narrows it further, because the two largest current draws in the system are both visible there: `grind PREDICTIVE` or `PULSE_EXECUTE` means the motor was running, and `cloud sync` anything other than `idle` means the WiFi radio was up and transmitting. A brownout that only ever lands on one of those points at the supply rather than the firmware.

`B internal free` is the other half. Internal DRAM is what LVGL, the BLE stack and WiFi station init all draw from; a `min` figure in the single-digit KB with a `PANIC` beside it is heap exhaustion, not a power fault.

### Resolution

**If the kind is `BROWNOUT` or `POWER_ON`:**
- Check what the ESP32 is powered from. Tapping the grinder's own supply works only if that rail can carry WiFi TX bursts (~350 mA peaks) on top of the relay coil.
- Add bulk capacitance across the 5 V input, or move the board to its own supply.
- A large negative weight excursion in a grind log (a dive to −90 g or so, tripping the negative-weight failsafe) is the same fault seen through the HX711: its output is ratiometric, so a sagging excitation reads as a huge negative weight. Those aborted grinds and the reboots usually share one cause.

**If the kind is `PANIC` or a watchdog:** it is a firmware fault. Include the whole `[BOOT HISTORY]` block in a GitHub issue — the state, phase and heap figures are what make it reproducible.

**Note:** a reset while the shot log is on screen no longer loses the shot. The prompt is written to NVS while it is displayed and comes back after the reboot, so the yield and time can still be entered. A clean power-on retires it instead of restoring a stale prompt.

---

## Getting Diagnostic Reports

**Applies to:** Reporting issues on GitHub or troubleshooting system behavior.

### What is a Diagnostic Report?

The diagnostic report is a comprehensive text dump of your device's current state, including:
- Firmware version, build number, and git commit
- Boot history: why each of the last 8 boots happened, and what the device was doing when the previous one ended
- System information (uptime, CPU frequency, RAM, flash storage)
- All compile-time constants (grind settings, thresholds, timeouts)
- Runtime statistics (lifetime grinds, total weight)
- Load cell calibration status and noise diagnostics
- Motor latency settings
- Autotune results (if available)

This information helps identify configuration issues, hardware problems, or firmware bugs.

### How to Get a Diagnostic Report

#### Option 1: Web Flasher (Recommended)

1. Visit the **[Web Flasher Diagnostics Tool](https://coffeegrinder.preetpatel.com)**
2. Click the **"Diagnostics"** tab
3. Click **"Connect & Get Diagnostics"**
4. Select your device from the Bluetooth pairing dialog
5. Wait for the report to complete (~5-10 seconds)
6. Click **"Copy to Clipboard"** or **"Download Report"**
7. Paste the report into your GitHub issue

**Browser Requirements:** Chrome, Edge, or Opera on desktop/Android (Web Bluetooth API required)

#### Option 2: Command Line Tool

If you have the development environment set up:

```bash
# Get diagnostics and display in terminal
python3 tools/grinder.py diagnostics

# Save diagnostics to a file
python3 tools/grinder.py diagnostics --save diagnostics.txt
```

### When to Include a Diagnostic Report

**Always include a diagnostic report when reporting:**
- Grinding accuracy issues (overshooting/undershooting)
- Timeout errors or slow taring
- Load cell calibration problems
- Motor response issues
- Any unexpected behavior or crashes
- Feature requests that depend on your hardware configuration

**The diagnostic report is anonymous** and contains no personal information. It only includes technical device settings and statistics.

### Including Grind Results in Your Report

**For grind-related issues, follow these steps before generating the diagnostic report:**

1. **Enable logging:** Menu → Data → Enable Logging
2. **Reproduce the issue:** Perform at least one grind where the issue occurs
3. **Generate diagnostics:** Use one of the methods above (Web Flasher or Command Line)

The diagnostic report will automatically include your recent grind session data, which is essential for troubleshooting accuracy issues, pulse corrections, timeout problems, and other grind behavior issues. Without recent grind data, it's much harder to diagnose what's going wrong.
