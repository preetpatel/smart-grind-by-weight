# Smart Grind By Weight - Web Flasher

A browser-based firmware flashing tool for the Smart Grind By Weight ESP32 coffee grinder.

## Features

### 🔌 Initial Setup (USB)
- First-time firmware installation via ESP Web Tools
- Uses Web Serial API for direct USB connection
- Perfect for factory setup or recovery
- Powered by [ESP Web Tools](https://esphome.github.io/esp-web-tools/) for browser-based flashing

### 📶 OTA Updates (Bluetooth)
- Over-the-air updates for installed grinders
- Web Bluetooth API for wireless connection
- Full firmware updates (no delta compression)
- Progress tracking and status updates

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
  Analytics when stored data exists
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

### For Initial Setup
1. Open the web flasher in Chrome/Edge
2. Go to the "Initial Setup" tab
3. Select a firmware version
4. Click "Flash via USB" - opens ESP Web Tools
5. Connect device via USB and flash

### For OTA Updates
1. Ensure grinder is powered and BLE enabled
2. Go to the "OTA Update" tab
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
