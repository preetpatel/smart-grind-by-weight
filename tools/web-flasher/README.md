# Smart Grind By Weight - Web Flasher

A browser-based firmware flashing tool for the Smart Grind By Weight ESP32 coffee grinder.

## Features

The UI has two top-level tabs mapping to the two things owners come here for:
**My Grinder** (device care: Get Started → Update → WiFi → Diagnostics, ordered
by the ownership journey) and **Analytics** (grind data). New visitors land on
My Grinder → Get Started; once a grinder has connected from that browser
(`grinderSeen` in localStorage), the default becomes Update — and the page
lands on Analytics whenever stored grind data exists.

### 🎛 Device strip & shared BLE session
- Between the masthead and the tabs sits a one-line device strip (part of the
  header chrome, mirroring the firmware's own status-icon corner): a compact
  pairing prompt for first-time visitors, or the known grinder's cached
  snapshot — firmware version, sessions stored on the device, WiFi/clock
  state, when it was last checked — with Refresh / + Add / Forget actions and
  a switcher when several grinders are paired. Red is reserved for flash
  actions; the strip's Connect uses the accent blue like the other
  talk-to-the-grinder buttons
- One GATT connection (`grinder-session.js`) is shared by every flow on the
  page: the browser chooser appears once, then Update, WiFi, Diagnostics and
  Analytics reuse the link. It auto-releases after 30 s idle so the grinder
  stays reachable by the Python tool and its own WiFi sync windows
- On every connect the session syncs the grinder's clock and re-reads the
  lightweight snapshot characteristics (build number, system info JSON,
  sessions/lifetime JSON, WiFi status JSON — under 2 s total)
- On Chrome 117+ (persistent Web Bluetooth permissions) the active grinder is
  refreshed silently in the background on page load via
  `navigator.bluetooth.getDevices()` — no chooser. Other browsers fall back to
  click-to-refresh
- The snapshot drives contextual states: an update-available chip/banner in
  the Update panel (device version vs newest release), SSID prefill and live
  status in the WiFi panel, and "N sessions ready to pull" in Analytics
- Known grinders live in localStorage (`grinderRegistry`, `activeGrinderId`),
  keyed by the stable per-origin Web Bluetooth device id; snapshots contain no
  secrets (the WiFi status characteristic never carries the password)

### 🔌 Get Started (USB)
- First-time firmware installation via ESP Web Tools
- Uses Web Serial API for direct USB connection
- Perfect for factory setup or recovery
- Powered by [ESP Web Tools](https://esphome.github.io/esp-web-tools/) for browser-based flashing
- Nudges to the WiFi tab after flashing, forming an implicit onboarding flow

### 📶 Update (Bluetooth OTA)
- Over-the-air updates for installed grinders
- Web Bluetooth API for wireless connection
- Full firmware updates (no delta compression)
- Progress tracking and status updates

### 🕐 WiFi (Bluetooth)
- Provisions the grinder's home-WiFi credentials over BLE so it can sync its
  clock via SNTP on its own — at boot (surviving power loss) and daily after
- Detects the browser's timezone and derives a POSIX TZ rule (`tz-posix.js`)
  from the browser's own DST knowledge, so the grinder handles daylight-saving
  transitions locally, forever, with no lookup table to go stale
- Writes `[0x01][ssid]\0[pass]\0[tz_rule]\0[tz_name]\0` to the WiFi config
  characteristic (write-only; credentials are never readable back) and follows
  the attempt live via the WiFi status characteristic (JSON notify)
- Check Status / Forget WiFi actions for existing devices — also the fix path
  after a router password change

### 📊 Grind Analytics (Bluetooth)
- Pulls grind sessions, system info, and the diagnostics report over one BLE connection
- Latest grind shown as a hero above the fold (final weight vs target with signed error),
  next to a fleet KPI strip (accuracy rate, mean error, σ, avg grind time) and an
  error-per-session sparkline; the newest session's full analysis opens automatically
- Full in-browser analysis dashboard: single-session phase charts (overall, predictive,
  pulse, vibration/FFT, controller), session-overlay Compare view (curves aligned at grind
  start, recency-colored), multi-session statistics, long-term Trends (error/flow/latency/
  pulse drift + a burr-wear odometer from the device's lifetime stats), and Device Health
- Syncs the grinder's wall clock on every connect; sessions ground afterwards show real
  dates instead of device uptime. Warns when grind logging is disabled on the device
- Data persists in the browser (IndexedDB) between visits; JSON export/import for sharing;
  Plotly is vendored (`vendor/plotly.min.js`) so charts work offline; the page lands on
  the Analytics tab when stored data exists
- Binary session parsing in `analytics/parser.js` — must stay aligned with
  `src/logging/grind_logging.h` (see `tools/ble/CLAUDE.md`)

## UI

The tool uses a dark instrument-panel theme derived from the firmware's own LVGL color
scheme (`src/config/constants.h`): black background, red primary action, blue accent, with
monospace tabular numerals for all telemetry. Chart series colors are CVD-validated for
the dark surface (see the palette note at the top of `analytics/charts.js`); grind result
statuses use a reserved status palette (COMPLETE/OVERSHOOT/MAX_PULSES/TIMEOUT) rendered as
dot + label badges so state never relies on color alone.

## Browser Support

- ✅ **Chrome** (Desktop & Android) - Full support
- ✅ **Microsoft Edge** (Desktop) - Full support  
- ❌ **Firefox** - No Web Bluetooth support
- ❌ **Safari/iOS** - No Web Bluetooth support

## Usage

### First-time install
1. Open the web flasher in Chrome/Edge
2. Go to My Grinder → "Get Started" (the default for new visitors)
3. Select a firmware version
4. Click "Flash via USB" - opens ESP Web Tools
5. Connect device via USB and flash
6. Follow the "set up WiFi" nudge to sync the grinder's clock

### Firmware updates
1. Ensure grinder is powered and BLE enabled
2. Go to My Grinder → "Update" (the default once a grinder has connected before)
3. Select a firmware version
4. Click "Connect & Flash Firmware"

## Firmware Sources

The firmware list is pulled straight from GitHub Releases—no files are stored in this repo. If you need the exact asset mapping, see [DOC.md](../../docs/DOC.md).

## Technical Details

### BLE Services Used
- **OTA Service**: `12345678-1234-1234-1234-123456789abc`
- **Data Transfer**: `87654321-4321-4321-4321-cba987654321`
- **Control Commands**: `11111111-2222-3333-4444-555555555555`
- **Status Updates**: `aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`

### Protocol
- Based on existing Python BLE implementation
- 512-byte chunks for firmware transfer
- Status notifications for progress tracking
- Command structure: START → DATA_CHUNKS → END

## Development

The web flasher is automatically deployed via GitHub Pages when pushed to main branch.

### Local Testing

**Quick Start (Recommended):**
```bash
# From the tools directory
python3 start-webflasher.py

# If port 8000 is busy, you'll be prompted to kill the process
# Use a custom port
python3 start-webflasher.py --port 3000
```

The script will automatically:
- Check if the port is available
- Prompt to kill any conflicting process
- Start the server and display the URL
- Handle cleanup on exit

**Manual Start:**
```bash
# Serve locally (required for Web Bluetooth HTTPS requirement)
python3 -m http.server 8000 --directory tools/web-flasher
# Open http://localhost:8000
```

**Note:** While the production site requires HTTPS for Web Bluetooth, `localhost` is an exception and works with plain HTTP.

## Security

- All communications use Web Bluetooth's built-in security
- Firmware is downloaded directly from GitHub releases
- No credentials or keys stored locally
- WiFi credentials are written straight to the grinder and never echoed back
  over BLE; the status characteristic reports SSID and state only
