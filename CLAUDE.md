## Project Overview

ESP32-S3 intelligent coffee scale with grind-by-weight functionality. Features predictive grinding system, LVGL touch UI, and BLE OTA updates. Automatically grinds coffee beans to precise target weights using flow prediction and pulse correction algorithms.

## Essential Commands

All development tasks use the unified cross-platform Python tool:

```bash
# Build and upload
python3 tools/grinder.py build-upload

# Data analysis (pulls grind data + system info + diagnostics over one BLE
# connection, stores a device health snapshot in the DB, launches Streamlit report)  
python3 tools/grinder.py analyze
```

**Common Commands:**
- `python3 tools/grinder.py build` - Build firmware only
- `python3 tools/grinder.py test` - Compile and run host-side C++ regression tests (also runs in CI)
- `python3 tools/grinder.py upload` - Upload latest firmware via BLE
- `python3 tools/grinder.py export` - Export grind data to database
- `python3 tools/grinder.py report` - Launch Streamlit report from existing data
- `python3 tools/grinder.py diagnostics` - Print device diagnostic report to the terminal (also captured by `analyze` into the dashboard's Device Health view)
- `python3 tools/grinder.py scan` - Scan for BLE devices
- `python3 tools/grinder.py info` - Get device system information
- `python3 tools/grinder.py clean` - Clean build artifacts

**BLE OTA reliability:** Delta updates diff the new firmware against the device's *current* image, so the base must match byte-for-byte. Local dev builds match `firmware_cache/build_NNN.bin` by build number; release-flashed devices never match a local cache entry (legacy CI compiled every release as build #1; `release.yml` now seeds unique numbers ≥100001 from the commit count), so the tool fetches the published release binary by the device's firmware version into `firmware_cache/release_v*.bin` and uses that as the base. On the device, the entire incoming patch is staged in PSRAM and flash is untouched until the transfer completes (`components/delta`; 16 KB-batch streaming fallback if PSRAM allocation fails) — flash erases/writes while BLE is streaming stalled the radio enough to drop the link partway through large transfers, every time. Both clients retry transient chunk-write failures, the Python tool waits out the 30–90 s apply phase (a 30 s wait used to report false failures mid-apply), and the web flasher waits for the device's own success/error status — verifying the running version after reboot when the link drops — instead of assuming success. Four safety nets on top: (1) a boot-loop guard (`src/system/boot_guard*`) reverts to the other OTA slot after 3 consecutive crash resets (panic/WDT only — power cycling never counts, and an empty second slot stands the guard down); (2) the firmware serves the running image's SHA-256 over BLE (`BLE_OTA_IMAGE_HASH_CHAR_UUID`, computed as `sha256(bin minus its appended 32-byte digest)`) and the Python tool refuses any delta base that doesn't match, falling back to full; (3) both clients append a zlib CRC-32 of the patch to the END command and the device verifies its flash-staged copy before applying (old client/firmware combinations degrade gracefully); (4) every OTA outcome — success or the precise failure stage — is persisted to NVS and shown in the diagnostics report under `[OTA / BOOT GUARD]`, so failed updates are diagnosable over BLE. The delta staging and CRC code is host-tested (`tools/tests/test_delta_staging.cpp` compiles the real `components/delta/delta.c` against fake-NOR stubs in `tools/tests/support/`; boot-guard decisions in `test_boot_guard.cpp`). The patch toolchain is pinned (`detools==0.53.0`/`heatshrink2==0.14.0` in both the venv and CI) and `test_patch_compat.cpp` guards the pins: it applies a patch generated at test time by the installed Python detools with the C decoder shipped in firmware — bump the pins only if that test still passes. Releases publish a `.sha256` manifest (from rc.6); the CLI verifies fetched delta bases and the web flasher verifies its OTA download against it, both skipping gracefully for older releases.

**BLE availability:** Bluetooth is on by default and stays on — there is no inactivity auto-disable, so clients can connect at any time. The BLE stack is initialized once and never deinitialized (Bluedroid rebuilds an empty GATT table on re-init while the Arduino wrapper keeps serving its stale objects), so `enable()`/`disable()` only start and stop advertising; "off" means "not advertising". The `bluetooth` NVS namespace holds `startup` (auto-enable at boot, default true); the menu's *Enabled* toggle is not persisted, so it turns the radio off only until the next reboot. Advertising is left at the wrapper's ~20–40 ms default — do not slow it down. Slowing it to 500 ms–1 s to cut radio duty was tried and made the grinder unreliable to find and connect to: at a realistic −75 dBm it is the fast rate's repetition that carries discovery and the CONNECT_IND exchange through packet loss, and load-cell noise measures identical either way, so there is nothing to buy. Note the surface is unauthenticated — no pairing/bonding and no OTA image signature check — which is accepted under the same home-appliance threat model as the plaintext WiFi credentials.

**Web Analytics:** The web flasher (`tools/web-flasher`) has two top-level tabs: **My Grinder** (device sub-tabs: Get Started/USB install, Update/OTA, WiFi, Diagnostics — new visitors land on Get Started, returning ones on Update via a `grinderSeen` localStorage flag) and an **Analytics** tab. Above the tabs sits a one-line device strip (`grinder-card.js`) — a pairing prompt for new visitors, cached device snapshot (version, sessions on device, WiFi state, update-available chip) for known ones; red is reserved for flash CTAs, the strip's Connect is accent blue. All four flows share one GATT connection via `grinder-session.js` (chooser once, 30 s idle auto-release, clock sync + snapshot reads on every connect, silent background refresh on Chrome 117+ via `getDevices()`; known grinders persist in `grinderRegistry` localStorage keyed by device id). Operations that outlast the idle window — firmware upload, grind-data export, the diagnostics stream — must claim the link with the nesting `hold()`/`releaseHold()` lease (always paired in a `finally`); while any holder is active `release()` is a no-op, so a concurrent flow (typically the device strip's background snapshot refresh) can't arm the idle timer and disconnect mid-transfer. The **Analytics** tab pulls grind data + a device health snapshot over Web Bluetooth and renders the full analysis dashboard in the browser (single-session, session-overlay compare, multi-session, long-term trends with a burr-wear odometer from lifetime stats, device health). Its binary parser (`tools/web-flasher/analytics/parser.js`) is a third consumer of the `grind_logging.h` structs — any struct change must update it alongside the Python parser (see `tools/ble/CLAUDE.md`). Grind data chunks are delivered as acknowledged BLE indications; the firmware retries unconfirmed chunks rather than dropping them.

**Grind Data Capture:** Session logging defaults to ON (`logging/enabled` preference, toggle under Menu → Logs & Data); cancelled grinds are never saved. Session retention is space-based: files accumulate on the 3 MB LittleFS partition until free space drops below a 256 KB reserve (then oldest are purged; hard cap 250 files, roughly 100+ sessions in practice). The dashboard and Python tool warn when logging is off.

**Time Sync:** Two sources feed `src/system/time_sync.h`. (1) Every BLE client (web flasher, Python tool) writes the wall clock on connect via `BLE_SYSINFO_TIMESYNC_CHAR_UUID` (`[epoch_utc:u32 LE][tz_offset_min:i16 LE]`). (2) If WiFi is provisioned, `WifiService` (`src/system/wifi_service.h`, runs from `loop()`) syncs via SNTP at boot — so the clock survives power loss — and daily after, with exponential backoff on failure. The radio is duty-cycled (up only for the seconds a sync takes) and attempts never start — and are torn down — while a grind, OTA, or BLE data export is active. Sessions started after a sync carry real Unix epochs in `session_timestamp` (uptime seconds otherwise — no schema change; parsers distinguish by magnitude). The synced clock shows top-left on the ready screen (the top-right corner belongs to the WiFi/warning/BLE status icons, laid out in a right-aligned flex row so hidden icons collapse instead of leaving gaps) and in System Info. Both render through `TimeSync::format_local_clock()`, which honours the 12/24-hour preference (`clock` NVS namespace, key `use_24h`, default false = AM/PM; toggle under Menu → Settings → Display, loaded at boot by `TimeSync::init()`).

**WiFi Provisioning:** Credentials arrive over BLE from the web flasher's WiFi tab (under My Grinder): `BLE_SYSINFO_WIFI_CONFIG_CHAR_UUID` (write-only: `[0x01][ssid]\0[pass]\0[tz_rule]\0[tz_name]\0` to set, `[0x02]` to forget) with JSON status readback on `BLE_SYSINFO_WIFI_STATUS_CHAR_UUID` (never contains the password). Stored in the `wifi` NVS namespace (`ssid`, `pass`, `enabled`, `tz_rule`, `tz_name`), plaintext by design (home-appliance threat model). The `tz_rule` is a POSIX TZ string derived in the browser (`tools/web-flasher/tz-posix.js`) from the browser's own DST knowledge; the firmware applies it via `setenv("TZ")`/`tzset()` so DST transitions happen locally with no network — it takes display precedence over the BLE clients' flat offset. Menu → Settings → WiFi has an enable toggle, status rows, and Forget Network. `WifiService` is deliberately a generic connection-window manager: phase-2 consumers (e.g. a session uploader firing on grind-complete) plug in without touching the lifecycle logic.

## Architecture

**4-Layer Architecture:**
1. **Hardware Layer** (`src/hardware/`): ESP32-S3 peripheral abstraction
2. **Control Layer** (`src/controllers/`): Business logic and algorithms  
3. **System Layer** (`src/system/`): State management
4. **UI Layer** (`src/ui/`): LVGL touchscreen interface

**Key Components:**
- **HardwareManager**: Central hardware coordinator
- **GrindController**: 9-phase state machine with predictive flow control, 10 pulse corrections with closed-loop flow feedback (each pulse's measured yield refines the flow estimate for the next, `pulse_flow_feedback.h`) and a cross-session pulse gain — a dimensionless EWMA of measured-vs-predicted pulse flow persisted in NVS (`pulse_gain`) that seeds the first pulse of every grind, since in-session feedback can only correct from the second pulse on — mechanical instability detection, and post-completion top-up pulses (both modes)
- **LoadCell (HX711)**: Multi-mode precision weight measurement (instant, smoothed, filtered), calibration flag, noise diagnostics
- **DiagnosticsController**: System health monitoring (calibration status, sustained noise, mechanical instability, signal saturation), state persistence, hysteresis, priority-based warnings. LOAD_CELL_SATURATED fires when raw ADC is pegged at a rail (0x000000/0xFFFFFF ± margin) for 10+ consecutive samples — indicates A+/A- wiring fault, and blocks weight-mode grinds in `GrindController::start_grind()` (time mode is unaffected)
- **UIManager**: 7 screens with LVGL integration; menu page surfaces quick Tools (Scale view, Calibrate, Tune Pulses, Motor Test) followed by Settings (Bluetooth, WiFi, Display, Grind Settings) and Info sections (Diagnostics, System Info, Logs & Data, Lifetime Stats), warning icon indicator, split-button layout for top-up pulses on the completion screen
- **StateMachine**: Central state coordination (READY → GRINDING → GRIND_COMPLETE)

**Update Intervals:** 20ms grind control, 25ms load cell (active), 50ms UI/hardware

**Grind Phases:**
- Standard phases: IDLE, INITIALIZING, SETUP, TARING, TARE_CONFIRM, PRIME, PRIME_SETTLING, PREDICTIVE, PULSE_DECISION, PULSE_EXECUTE, PULSE_SETTLING, FINAL_SETTLING, TIME_GRINDING, COMPLETED, TIMEOUT
- `TIME_ADDITIONAL_PULSE` - Dedicated phase for post-completion top-up pulses in **both** weight and time mode. Name kept for on-flash log compatibility (`phase_id` ordinals are decoded by `phase_names[]` in `src/bluetooth/manager.cpp`). The phase is held after the pulse until the scale settles, so `final_weight` captures the full yield
- `PURGE_CONFIRM` - Pauses after chute operation (in Purge mode) to allow user to discard grinds before continuing to main grind
- **Timeout**: 30-second maximum from grind start (includes taring), auto-stops and requires user acknowledgment

**Grinder Purge/Prime:**
- **Always runs** before weight-mode grinding to saturate the grinder for accurate latency detection
- **Prime mode**: Keeps coffee, continues immediately to PREDICTIVE phase
- **Purge mode** (default): Shows confirmation popup, waits for user to discard stale grinds, then continues
- **Configurable amount**: 0.1g-5.0g (default 1.0g), replaces old hardcoded `GRIND_PRIME_TARGET_WEIGHT_G`. Stop is coast-compensated (`GRIND_PRIME_COAST_COMPENSATION_MS`) so the configured amount is what actually lands
- **Purge popup**: "Keep purge grinds from now on" checkbox (checked by default) switches mode from Purge → Prime in preferences
- **Logging disabled** during PURGE_CONFIRM phase to avoid capturing data while paused
- **Preferences**: `chute_mode` (int: 0=Prime, 1=Purge, default=1), `chute_amount_g` (float: 0.1-5.0, default=1.0)

**Top-Up Pulses:** Split-button completion screen (OK + PULSE) in both weight and time mode, `TIME_ADDITIONAL_PULSE` phase, fixed 100ms duration (~0.1-0.2g). No re-tare and no purge, so a grind that landed at 17.8g can be nudged to 18.0g. Weight and arc update live while grounds land (the frozen `final_weight` in `emit_progress_update` only applies once back in `COMPLETED`); button is disabled during pulse+settle. Pulses are **not** reflected in the stored session log — the session is finalized on first entry to `COMPLETED`

**Grind Settings:** Configurable through Menu → Grind Settings page
- **Mode Selection**: Radio buttons for Weight/Time mode selection
- **Swipe Gestures Toggle**: Enable/disable vertical swipe gestures for mode switching (default: disabled)
- **Automation**: Start on Cup and Return on Removal toggles
- **Purging**: Radio buttons (Prime/Purge) and Amount slider (0.1g-5.0g)
- **Preferences**: `swipe.enabled` (boolean), `grind_mode` (0=Weight, 1=Time), `chute_mode` (0=Prime, 1=Purge), `chute_amount_g` (float)
- **Behavior**: Swipe gestures only work when enabled; direct mode selection always works

**Color Scheme (RGB565):**
- `COLOR_PRIMARY`: 0xFF0000 (Red) - Primary theme color
- `COLOR_ACCENT`: 0x00AAFF (Blue) - Highlights and accents
- `COLOR_SUCCESS`: 0x00AA00 (Green) - Success states
- `COLOR_WARNING`: 0xCC8800 (Orange) - Warning states
- `COLOR_BACKGROUND`: 0x000000 (Black) - Background
- `COLOR_TEXT_PRIMARY`: 0xFFFFFF (White) - Primary text

**Font Usage Hierarchy:**
- `lv_font_montserrat_24`: Standard text and button labels
- `lv_font_montserrat_32`: Button symbols (OK, CLOSE, PLUS, MINUS)
- `lv_font_montserrat_36`: Screen titles
- `lv_font_montserrat_56`: Large weight displays

## Development Notes

* When modifying this codebase, follow the existing architectural patterns, maintain the clean separation between layers, and ensure any timing-critical code respects the established update intervals.
* use macos compatible commands. macos uses python3
* after making a test build let me know the build number
* Always read entire files. Otherwise, you don’t know what you don’t know, and will end up making mistakes, duplicating code that already exists, or misunderstanding the architecture.  
* Commit early and often. When working on large tasks, your task could be broken down into multiple logical milestones. After a certain milestone is completed and confirmed to be ok by the user, you should commit it. If you do not, if something goes wrong in further steps, we would need to end up throwing away all the code, which is expensive and time consuming.  
* Your internal knowledgebase of libraries might not be up to date. When working with any external library, unless you are 100% sure that the library has a super stable interface, you will look up the latest syntax and usage via either Perplexity (first preference) or web search (less preferred, only use if Perplexity is not available)  
* Do not say things like: “x library isn’t working so I will skip it”. Generally, it isn’t working because you are using the incorrect syntax or patterns. This applies doubly when the user has explicitly asked you to use a specific library, if the user wanted to use another library they wouldn’t have asked you to use a specific one in the first place.  
* Always run linting after making major changes. Otherwise, you won’t know if you’ve corrupted a file or made syntax errors, or are using the wrong methods, or using methods in the wrong way.   
* Please organise code into separate files wherever appropriate, and follow general coding best practices about variable naming, modularity, function complexity, file sizes, commenting, etc.  
* Code is read more often than it is written, make sure your code is always optimised for readability  
* Unless explicitly asked otherwise, the user never wants you to do a “dummy” implementation of any given task. Never do an implementation where you tell the user: “This is how it *would* look like”. Just implement the thing.  
* Whenever you are starting a new task, it is of utmost importance that you have clarity about the task. You should ask the user follow up questions if you do not, rather than making incorrect assumptions.  
* Do not carry out large refactors unless explicitly instructed to do so.  
* When starting on a new task, you should first understand the current architecture, identify the files you will need to modify, and come up with a Plan. In the Plan, you will think through architectural aspects related to the changes you will be making, consider edge cases, and identify the best approach for the given task. Get your Plan approved by the user before writing a single line of code.   
* If you are running into repeated issues with a given task, figure out the root cause instead of throwing random things at the wall and seeing what sticks, or throwing in the towel by saying “I’ll just use another library / do a dummy implementation”.   
* You are an incredibly talented and experienced polyglot with decades of experience in diverse areas such as software architecture, system design, development, UI & UX, copywriting, and more.  
* When doing UI & UX work, make sure your designs are both aesthetically pleasing, easy to use, and follow UI / UX best practices. You pay attention to interaction patterns, micro-interactions, and are proactive about creating smooth, engaging user interfaces that delight users.   
* When you receive a task that is very large in scope or too vague, you will first try to break it down into smaller subtasks. If that feels difficult or still leaves you with too many open questions, push back to the user and ask them to consider breaking down the task for you, or guide them through that process. This is important because the larger the task, the more likely it is that things go wrong, wasting time and energy for everyone involved.
- Touch polling now uses the IDF I2C master driver with ACK checking disabled so idle NACKs don't spam logs. Toggle `DEBUG_SUPPRESS_TOUCH_I2C_ERRORS` to 0 if you need the raw driver output for troubleshooting.
- Use the src/config/constants.h aggregation file to include constants / settings - dont refer to config files directly.
- When new features have been added and tested always update the docs as well
- when making a commit, only focus on the end result not the process we went through to get to the end result
- when publishing a release, always include changelogs describing what changed since the previous release
