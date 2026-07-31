// Smart Grind By Weight - Web Bluetooth Flasher
// Based on your existing Python BLE implementation

// Firmware index metadata
const FIRMWARE_INDEX_URL = 'firmware/index.json';

// BLE Service UUIDs (from your bluetooth.h config)
const BLE_OTA_SERVICE_UUID = '12345678-1234-1234-1234-123456789abc';
const BLE_OTA_DATA_CHAR_UUID = '87654321-4321-4321-4321-cba987654321';
const BLE_OTA_CONTROL_CHAR_UUID = '11111111-2222-3333-4444-555555555555';
const BLE_OTA_STATUS_CHAR_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const BLE_OTA_BUILD_NUMBER_CHAR_UUID = '66666666-7777-8888-9999-000000000000';

// Debug Service UUIDs
const BLE_DEBUG_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const BLE_DEBUG_TX_CHAR_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

// System Info Service UUIDs
const BLE_SYSINFO_SERVICE_UUID = '77889900-aabb-ccdd-eeff-112233445566';
const BLE_SYSINFO_DIAGNOSTICS_CHAR_UUID = '22334455-ff00-1111-2222-334455667788';
const BLE_SYSINFO_TIMESYNC_CHAR_UUID = '33445566-ff00-1111-2222-334455667788';
const BLE_SYSINFO_WIFI_CONFIG_CHAR_UUID = '44556677-ff00-1111-2222-334455667788';
const BLE_SYSINFO_WIFI_STATUS_CHAR_UUID = '556677ee-ff00-1111-2222-334455667788';

// Commands and status codes (from your Python implementation)
const BLE_OTA_CMD_START = 0x01;
const BLE_OTA_CMD_END = 0x03;
const BLE_OTA_CMD_ABORT = 0x04;

const BLE_OTA_IDLE = 0x00;
const BLE_OTA_READY = 0x01;
const BLE_OTA_RECEIVING = 0x02;
const BLE_OTA_SUCCESS = 0x03;
const BLE_OTA_ERROR = 0x04;

const DEVICE_NAME = 'GrindByWeight';
const CHUNK_SIZE = 512; // Browser BLE limit - cannot exceed 512 bytes per write

// Global state. The BLE connection itself lives in GrinderSession
// (grinder-session.js) and is shared by every flow on the page.
let otaService = null;
let currentOtaStatus = BLE_OTA_IDLE;
let statusCharacteristic = null;
let cachedFirmwareIndex = null;

async function fetchFirmwareIndex() {
    if (!cachedFirmwareIndex) {
        const response = await fetch(FIRMWARE_INDEX_URL, { cache: 'no-store' });
        if (!response.ok) {
            throw new Error(`Failed to load firmware index (${response.status})`);
        }
        cachedFirmwareIndex = await response.json();
    }
    return cachedFirmwareIndex;
}

function resolveFirmwareUrl(relativePath) {
    return new URL(relativePath, window.location.href).href;
}

// Remembers whether this browser has ever talked to a grinder (the flag is
// written by GrinderSession on every successful connect). Drives the default
// My Grinder sub-tab: new visitors land on Get Started, returning owners on
// Update.
const GRINDER_SEEN_KEY = 'grinderSeen';

function hasSeenGrinder() {
    try {
        if (localStorage.getItem(GRINDER_SEEN_KEY)) return true;
    } catch (e) { /* private mode */ }
    return !!(window.GrinderSession && window.GrinderSession.getActive());
}

// Browser support check and load releases
window.addEventListener('load', () => {
    const hasBluetooth = 'bluetooth' in navigator;
    if (!hasBluetooth) {
        document.getElementById('browserWarning').style.display = 'block';
        // Update, WiFi and Diagnostics all need Web Bluetooth
        ['ota', 'wifi', 'diagnostics'].forEach(name => {
            const tab = document.querySelector(`.sub-tab[onclick="showGrinderTab('${name}')"]`);
            if (tab) {
                tab.disabled = true;
                tab.style.opacity = '0.5';
            }
        });
    }

    showGrinderTab(hasBluetooth && hasSeenGrinder() ? 'ota' : 'initial');

    // Load available releases
    loadReleases();
});

// Tab switching. Looks the button up by name (rather than relying on the
// click event) so it also works when called programmatically, e.g. to land on
// Analytics when stored grind data exists.
function showTab(tabName) {
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
    });
    document.querySelectorAll('.tab').forEach(tab => {
        tab.classList.remove('active');
    });

    document.getElementById(tabName + 'Tab').classList.add('active');
    const button = document.querySelector(`.tab[onclick="showTab('${tabName}')"]`);
    if (button) button.classList.add('active');
}

// Sub-tab switching within My Grinder. Scoped to .device-nav so the
// analytics dashboard's own sub-tabs are unaffected.
function showGrinderTab(name) {
    document.querySelectorAll('.sub-panel').forEach(panel => {
        panel.classList.remove('active');
    });
    document.querySelectorAll('.sub-tabs.device-nav .sub-tab').forEach(tab => {
        tab.classList.remove('active');
    });

    document.getElementById(name + 'Panel').classList.add('active');
    const button = document.querySelector(`.sub-tab[onclick="showGrinderTab('${name}')"]`);
    if (button) button.classList.add('active');
}

// Status update functions
function updateStatus(message, type = 'info') {
    const statusDiv = document.getElementById('status');
    statusDiv.textContent = message;
    statusDiv.className = `status ${type}`;
    statusDiv.style.display = 'block';
    console.log(`[${type.toUpperCase()}] ${message}`);
}

function updateProgress(percent) {
    const progressContainer = document.getElementById('progressContainer');
    const progressBar = document.getElementById('progressBar');
    
    if (percent > 0) {
        progressContainer.style.display = 'block';
        progressBar.style.width = percent + '%';
    } else {
        progressContainer.style.display = 'none';
    }
}

// Utility functions
function arrayBufferToHex(buffer) {
    return Array.from(new Uint8Array(buffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Firmware download
async function downloadFirmware(url) {
    if (!url) {
        throw new Error('No firmware URL provided');
    }

    updateStatus(`Downloading firmware from ${url}`, 'info');
    updateProgress(0);

    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const contentLength = parseInt(response.headers.get('content-length'));
    const reader = response.body.getReader();
    const chunks = [];
    let receivedBytes = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        chunks.push(value);
        receivedBytes += value.length;

        if (contentLength) {
            const progress = (receivedBytes / contentLength) * 100;
            updateProgress(progress);
        }
    }

    const firmware = new Uint8Array(receivedBytes);
    let offset = 0;
    for (const chunk of chunks) {
        firmware.set(chunk, offset);
        offset += chunk.length;
    }

    updateStatus(`Downloaded ${Math.round(firmware.length / 1024)}KB firmware`, 'success');
    return firmware;
}

// Combined connect and flash function
async function connectAndFlash() {
    const connectFlashBtn = document.getElementById('connectFlashBtn');

    if (!('bluetooth' in navigator)) {
        updateStatus('Web Bluetooth not supported in this browser', 'error');
        return;
    }

    connectFlashBtn.disabled = true;
    try {
        updateStatus('Connecting to grinder...', 'info');
        await GrinderSession.connect();

        updateStatus('Getting OTA service...', 'info');
        otaService = await GrinderSession.getService(BLE_OTA_SERVICE_UUID);

        // Set up status notifications. The characteristic object persists for
        // the life of the shared connection, so drop any handler from an
        // earlier flash attempt before adding ours.
        statusCharacteristic = await otaService.getCharacteristic(BLE_OTA_STATUS_CHAR_UUID);
        statusCharacteristic.removeEventListener('characteristicvaluechanged', handleStatusUpdate);
        await statusCharacteristic.startNotifications();
        statusCharacteristic.addEventListener('characteristicvaluechanged', handleStatusUpdate);

        updateStatus('Connected successfully!', 'success');
        await flashFirmware();
    } catch (error) {
        updateStatus(`Connection failed: ${error.message}`, 'error');
        console.error('Connection error:', error);
    } finally {
        connectFlashBtn.disabled = false;
        GrinderSession.release();
    }
}

// Status notification handler
function handleStatusUpdate(event) {
    const value = new Uint8Array(event.target.value.buffer);
    if (value.length > 0) {
        currentOtaStatus = value[0];
        console.log(`OTA Status: ${currentOtaStatus}`);
        
        switch (currentOtaStatus) {
            case BLE_OTA_READY:
                updateStatus('Device ready for firmware', 'info');
                break;
            case BLE_OTA_RECEIVING:
                updateStatus('Device receiving firmware...', 'info');
                break;
            case BLE_OTA_SUCCESS:
                updateStatus('Firmware update successful!', 'success');
                updateProgress(100);
                break;
            case BLE_OTA_ERROR:
                updateStatus('Firmware update failed', 'error');
                break;
        }
    }
}

// Wait for specific OTA status
async function waitForOtaStatus(expectedStatus, timeoutMs = 30000) {
    const startTime = Date.now();
    
    return new Promise((resolve, reject) => {
        const checkStatus = () => {
            if (currentOtaStatus === expectedStatus) {
                resolve(true);
                return;
            }
            
            if (Date.now() - startTime > timeoutMs) {
                reject(new Error(`Timeout waiting for OTA status ${expectedStatus}`));
                return;
            }
            
            setTimeout(checkStatus, 100);
        };
        
        checkStatus();
    });
}

// Extract firmware version from firmware URL
function extractVersionFromUrl(url, fallbackVersion = null) {
    if (fallbackVersion) {
        return fallbackVersion;
    }

    const pagesMatch = url.match(/firmware\/v([^/]+)\//i);
    if (pagesMatch) {
        return pagesMatch[1];
    }
    // Extract version directly from GitHub release URL
    const versionMatch = url.match(/\/releases\/download\/v?(\d+\.\d+\.\d+(?:-[\w\.]+)?)/);
    if (versionMatch) {
        return versionMatch[1];
    }
    return null;
}

// Web flasher always does full updates (no delta compression)
function prepareFirmwareData(firmwareData) {
    return firmwareData;
}

// Main firmware flash function
async function flashFirmware() {
    const firmwareSelect = document.getElementById('firmwareSelect');

    if (!firmwareSelect) {
        updateStatus('Firmware selection element not found', 'error');
        return;
    }

    const selectedOption = firmwareSelect.selectedOptions[0];
    const firmwareUrl = selectedOption ? (selectedOption.dataset?.ota || firmwareSelect.value) : firmwareSelect.value;
    if (!firmwareUrl) {
        updateStatus('Please select a firmware version', 'error');
        return;
    }

    if (!GrinderSession.isConnected()) {
        updateStatus('Not connected to device', 'error');
        return;
    }
    
    try {
        // Download firmware
        const firmwareData = await downloadFirmware(firmwareUrl);
        const patchData = prepareFirmwareData(firmwareData);
        
        updateStatus('Starting firmware update...', 'info');
        updateProgress(0);
        
        // Get current device build number (optional)
        let deviceBuild = null;
        try {
            const buildChar = await otaService.getCharacteristic(BLE_OTA_BUILD_NUMBER_CHAR_UUID);
            const buildData = await buildChar.readValue();
            deviceBuild = new TextDecoder().decode(buildData).trim();
            if (deviceBuild && deviceBuild !== 'no_build_number') {
                updateStatus(`Current device build: #${deviceBuild}`, 'info');
            }
        } catch (e) {
            console.log('Could not read device build number');
        }
        
        // Extract expected version from URL
        const expectedVersion = selectedOption?.dataset?.version || extractVersionFromUrl(firmwareUrl);
        if (expectedVersion) {
            updateStatus(`Installing version: ${expectedVersion}`, 'info');
        }
        
        // Send OTA start command
        const controlChar = await otaService.getCharacteristic(BLE_OTA_CONTROL_CHAR_UUID);
        const dataChar = await otaService.getCharacteristic(BLE_OTA_DATA_CHAR_UUID);
        
        // Build start command: [CMD][patch_size:4][is_full_update:1][build_number_length:1][build_number:N][firmware_version_length:1][firmware_version:M]
        const buildNumberBytes = new TextEncoder().encode("1"); // Web flasher always sends build #1
        const versionBytes = expectedVersion ? new TextEncoder().encode(expectedVersion) : new Uint8Array(0);
        
        const startData = new ArrayBuffer(1 + 4 + 1 + 1 + buildNumberBytes.length + 1 + versionBytes.length);
        const startView = new DataView(startData);
        let offset = 0;
        
        startView.setUint8(offset, BLE_OTA_CMD_START);
        offset += 1;
        
        startView.setUint32(offset, patchData.length, true); // little-endian
        offset += 4;
        
        startView.setUint8(offset, 0); // is_full_update = 0 (use delta path with detools patch)
        offset += 1;
        
        // Always send build number "1" for web flasher
        startView.setUint8(offset, buildNumberBytes.length);
        offset += 1;
        new Uint8Array(startData, offset).set(buildNumberBytes);
        offset += buildNumberBytes.length;
        
        // Send firmware version if available
        if (expectedVersion) {
            startView.setUint8(offset, versionBytes.length);
            offset += 1;
            new Uint8Array(startData, offset).set(versionBytes);
            updateStatus(`Sending expected firmware version: ${expectedVersion}`, 'info');
        } else {
            startView.setUint8(offset, 0); // no firmware version
        }
        
        await controlChar.writeValue(startData);
        updateStatus('Sent start command, waiting for device...', 'info');
        
        // Wait for device to be ready
        await waitForOtaStatus(BLE_OTA_RECEIVING, 15000);
        
        // Send firmware data in chunks
        updateStatus('Uploading firmware...', 'info');
        const totalChunks = Math.ceil(patchData.length / CHUNK_SIZE);
        let chunkCount = 0;
        
        for (let i = 0; i < patchData.length; i += CHUNK_SIZE) {
            const chunk = patchData.slice(i, i + CHUNK_SIZE);
            await dataChar.writeValue(chunk);
            
            chunkCount++;
            // Update progress every 10 chunks (much faster UI)
            if (chunkCount % 10 === 0 || i + CHUNK_SIZE >= patchData.length) {
                const progress = Math.round(((i + chunk.length) / patchData.length) * 100);
                updateProgress(progress);
                updateStatus(`Uploading: ${progress}%`, 'info');
            }
            
            // No delay - let browser BLE handle flow control naturally
        }

        updateStatus('Upload complete, applying update...', 'info');
        
        // Send end command
        try {
            const endCommand = new Uint8Array([BLE_OTA_CMD_END]);
            await controlChar.writeValue(endCommand);
            
            // Wait for completion or device disconnect (both are success indicators)
            try {
                await waitForOtaStatus(BLE_OTA_SUCCESS, 15000);
                updateStatus('Firmware update completed successfully!', 'success');
            } catch (statusError) {
                // Timeout or disconnect during final phase is normal - device is rebooting
                updateStatus('Firmware update completed - device rebooting', 'success');
            }
            
        } catch (endError) {
            // If END command fails, device likely already disconnected (success!)
            if (endError.message.includes('GATT') || endError.message.includes('disconnect')) {
                updateStatus('Firmware update completed - device rebooting', 'success');
            } else {
                throw endError;
            }
        }
        
        updateProgress(100);

        // Reset progress after delay
        setTimeout(() => {
            updateProgress(0);
        }, 3000);

        // The device reboots into the new firmware; refresh the cached
        // snapshot once it's back up so the card and update banner reflect
        // the new version. Silent and best-effort.
        setTimeout(() => {
            GrinderSession.refreshSnapshot({ interactive: false }).catch(() => {});
        }, 25000);

    } catch (error) {
        updateStatus(`Flash failed: ${error.message}`, 'error');
        console.error('Flash error:', error);
        
        // Try to abort OTA on error
        try {
            if (otaService) {
                const controlChar = await otaService.getCharacteristic(BLE_OTA_CONTROL_CHAR_UUID);
                const abortCommand = new Uint8Array([BLE_OTA_CMD_ABORT]);
                await controlChar.writeValue(abortCommand);
            }
        } catch (abortError) {
            console.error('Could not send abort command:', abortError);
        }
    }
}

// Point the ESP Web Tools button at the selected release's manifest. The
// dropdown itself shows the selection; no echoing status line.
function updateManifestFirmware() {
    const select = document.getElementById('usbFirmwareSelect');
    const selectedOption = select.selectedOptions[0];
    const manifestUrl = selectedOption?.dataset?.manifest || select.value;

    if (manifestUrl) {
        const installButton = document.getElementById('usbInstallButton');
        installButton.setAttribute('manifest', manifestUrl);
    }
}

// Firmware selection is now handled directly by dropdown


// Load firmware releases from GitHub API using asset labels for metadata
async function loadReleases() {
    const usbSelect = document.getElementById('usbFirmwareSelect');
    const otaSelect = document.getElementById('firmwareSelect');
    const showRC = document.getElementById('showReleaseCandidate').checked;
    const showRCOTA = document.getElementById('showReleaseCandidateOTA').checked;

    if (!usbSelect || !otaSelect) {
        console.error('Firmware select elements not found');
        return;
    }

    try {
        usbSelect.innerHTML = '<option value="">Loading firmware...</option>';
        otaSelect.innerHTML = '<option value="">Loading firmware...</option>';

        const indexEntries = await fetchFirmwareIndex();

        usbSelect.innerHTML = '';
        otaSelect.innerHTML = '';

        indexEntries.forEach(entry => {
            const label = entry.prerelease ? `${entry.display || entry.tag} (pre-release)` : (entry.display || entry.tag);
            const manifestUrl = entry.manifest ? resolveFirmwareUrl(entry.manifest) : null;
            const otaUrl = entry.ota ? resolveFirmwareUrl(entry.ota) : null;

            if (manifestUrl && (!entry.prerelease || showRC)) {
                const option = document.createElement('option');
                option.value = manifestUrl;
                option.textContent = label;
                option.dataset.display = label;
                option.dataset.version = entry.version || entry.tag.replace(/^v/, '');
                option.dataset.releaseTag = entry.tag;
                option.dataset.manifest = manifestUrl;
                option.dataset.prerelease = entry.prerelease ? 'true' : 'false';
                usbSelect.appendChild(option);
            }

            if (otaUrl && (!entry.prerelease || showRCOTA)) {
                const option = document.createElement('option');
                option.value = otaUrl;
                option.textContent = label;
                option.dataset.display = label;
                option.dataset.version = entry.version || entry.tag.replace(/^v/, '');
                option.dataset.releaseTag = entry.tag;
                option.dataset.ota = otaUrl;
                option.dataset.prerelease = entry.prerelease ? 'true' : 'false';
                otaSelect.appendChild(option);
            }
        });

        // Publish the newest release for the grinder card and the Update
        // panel's up-to-date/update-available banner (grinder-card.js).
        const stable = indexEntries.find(entry => !entry.prerelease) || null;
        window.latestFirmware = {
            stable: stable ? { version: stable.version || stable.tag.replace(/^v/, ''), tag: stable.tag } : null,
        };
        window.dispatchEvent(new CustomEvent('releases-loaded'));

        if (!usbSelect.children.length) {
            usbSelect.innerHTML = '<option value="">No firmware available</option>';
        } else {
            usbSelect.selectedIndex = 0;
            updateManifestFirmware();
        }

        if (!otaSelect.children.length) {
            otaSelect.innerHTML = '<option value="">No firmware available</option>';
        } else {
            otaSelect.selectedIndex = 0;
        }
    } catch (error) {
        console.error('Failed to load releases from GitHub:', error);
        usbSelect.innerHTML = '<option value="">Unable to load releases</option>';
        otaSelect.innerHTML = '<option value="">Unable to load releases</option>';
        updateStatus('Failed to load firmware list from GitHub releases. Please check your connection or try again later.', 'error');
    }
}

// ========================================================================
// DIAGNOSTIC REPORT FUNCTIONS
// ========================================================================

async function getDiagnosticReport() {
    const btn = document.getElementById('getDiagnosticsBtn');
    const statusDiv = document.getElementById('diagnosticsStatus');
    const reportContainer = document.getElementById('diagnosticsReportContainer');
    const reportTextarea = document.getElementById('diagnosticsReport');
    let debugTxChar = null;
    let onChunk = null;

    try {
        btn.disabled = true;
        statusDiv.innerHTML = '<div class="status info">Connecting to device...</div>';

        await GrinderSession.connect();
        statusDiv.innerHTML = '<div class="status info">Connected. Requesting diagnostic report...</div>';

        // Get required services
        const debugService = await GrinderSession.getService(BLE_DEBUG_SERVICE_UUID);
        const sysinfoService = await GrinderSession.getService(BLE_SYSINFO_SERVICE_UUID);

        // Get characteristics
        debugTxChar = await debugService.getCharacteristic(BLE_DEBUG_TX_CHAR_UUID);
        const diagnosticsChar = await sysinfoService.getCharacteristic(BLE_SYSINFO_DIAGNOSTICS_CHAR_UUID);

        // Collect report chunks
        let reportChunks = [];
        let reportComplete = false;

        // Try to stop notifications first (in case they're already active)
        try {
            await debugTxChar.stopNotifications();
            await new Promise(resolve => setTimeout(resolve, 200)); // Brief delay
        } catch (e) {
            // Ignore if notifications weren't active
        }

        // Set up notification handler
        await debugTxChar.startNotifications();
        onChunk = (event) => {
            const chunk = new TextDecoder().decode(event.target.value);
            reportChunks.push(chunk);

            // Check if report is complete
            if (chunk.includes('=== END OF REPORT ===')) {
                reportComplete = true;
            }
        };
        debugTxChar.addEventListener('characteristicvaluechanged', onChunk);

        // Trigger report generation by writing to diagnostics characteristic
        await diagnosticsChar.writeValue(new Uint8Array([0x01]));
        statusDiv.innerHTML = '<div class="status info">Generating report...</div>';

        // Wait for report to complete (with timeout)
        const timeout = 30000; // 30 seconds
        const startTime = Date.now();
        while (!reportComplete && (Date.now() - startTime) < timeout) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        if (reportComplete) {
            // Display report
            const fullReport = reportChunks.join('');
            reportTextarea.value = fullReport;
            reportContainer.style.display = 'block';
            statusDiv.innerHTML = '<div class="status success">✓ Diagnostic report generated successfully!</div>';
        } else {
            statusDiv.innerHTML = '<div class="status error">Report generation timed out. Partial report received.</div>';
            const partialReport = reportChunks.join('');
            if (partialReport) {
                reportTextarea.value = partialReport;
                reportContainer.style.display = 'block';
            }
        }
    } catch (error) {
        console.error('Diagnostic error:', error);
        statusDiv.innerHTML = `<div class="status error">Error: ${error.message}</div>`;
    } finally {
        // Leave the shared connection clean for the next flow.
        if (debugTxChar) {
            if (onChunk) debugTxChar.removeEventListener('characteristicvaluechanged', onChunk);
            try {
                await debugTxChar.stopNotifications();
            } catch (e) {
                // Ignore cleanup errors
            }
        }
        GrinderSession.release();
        btn.disabled = false;
    }
}

function copyDiagnosticReport() {
    const reportTextarea = document.getElementById('diagnosticsReport');
    const statusDiv = document.getElementById('diagnosticsStatus');

    reportTextarea.select();
    reportTextarea.setSelectionRange(0, 99999); // For mobile devices

    try {
        document.execCommand('copy');
        statusDiv.innerHTML = '<div class="status success">✓ Report copied to clipboard!</div>';
        setTimeout(() => {
            statusDiv.innerHTML = '';
        }, 3000);
    } catch (error) {
        statusDiv.innerHTML = '<div class="status error">Failed to copy report.</div>';
    }
}

function downloadDiagnosticReport() {
    const reportTextarea = document.getElementById('diagnosticsReport');
    const statusDiv = document.getElementById('diagnosticsStatus');

    try {
        const report = reportTextarea.value;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
        const filename = `grinder-diagnostics-${timestamp}.txt`;

        const blob = new Blob([report], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        statusDiv.innerHTML = '<div class="status success">✓ Report downloaded!</div>';
        setTimeout(() => {
            statusDiv.innerHTML = '';
        }, 3000);
    } catch (error) {
        statusDiv.innerHTML = '<div class="status error">Failed to download report.</div>';
    }
}

// ========================================================================
// WIFI SETUP FUNCTIONS
// ========================================================================
// Provisions WiFi credentials + a POSIX timezone rule over BLE so the
// grinder can sync its clock via SNTP on its own (see src/system/wifi_service.h).
// Payload format: [0x01][ssid]\0[pass]\0[tz_rule]\0[tz_name]\0 ; [0x02] = forget.

let detectedTz = null;

function updateWifiStatusBox(message, type = 'info') {
    const statusDiv = document.getElementById('wifiStatus');
    statusDiv.textContent = message;
    statusDiv.className = `status ${type}`;
    statusDiv.style.display = 'block';
}

// Populate the timezone display on load
window.addEventListener('load', () => {
    const tzDisplay = document.getElementById('wifiTzDisplay');
    if (!tzDisplay) return;
    try {
        detectedTz = detectPosixTz();
        tzDisplay.textContent = `${detectedTz.zoneName} — rule ${detectedTz.rule}`;
        tzDisplay.className = 'status success';
    } catch (error) {
        console.error('Timezone detection failed:', error);
        detectedTz = { rule: '', zoneName: '' };
        tzDisplay.textContent = 'Timezone detection failed — clock will sync in UTC';
        tzDisplay.className = 'status error';
    }
});

// The shared session already syncs the grinder's clock on every connect, so
// this only needs the two WiFi characteristics.
async function connectWifiChars() {
    await GrinderSession.connect();
    const sysinfoService = await GrinderSession.getService(BLE_SYSINFO_SERVICE_UUID);
    const configChar = await sysinfoService.getCharacteristic(BLE_SYSINFO_WIFI_CONFIG_CHAR_UUID);
    const statusChar = await sysinfoService.getCharacteristic(BLE_SYSINFO_WIFI_STATUS_CHAR_UUID);
    return { configChar, statusChar };
}

function describeWifiStatus(status) {
    if (!status.configured) return 'No WiFi credentials stored on the grinder.';
    const parts = [`Network: ${status.ssid}`];
    if (!status.enabled) {
        parts.push('WiFi is turned off on the grinder.');
    } else {
        const stateText = {
            idle: status.last_result === 'success' ? 'Synced — radio off until the next daily sync'
                : status.last_result === 'wifi_failed' ? 'Could not join the network (check the password)'
                : status.last_result === 'sntp_failed' ? 'Joined the network but got no time-server response'
                : status.last_result === 'aborted' ? 'Deferred (grinder was busy), will retry shortly'
                : 'Waiting for the first sync attempt',
            connecting: 'Connecting to the network…',
            syncing: 'Connected — syncing the clock…',
            disabled: 'WiFi is turned off on the grinder.',
            not_configured: 'No credentials stored.',
        }[status.state] || status.state;
        parts.push(stateText);
    }
    if (status.tz_name) parts.push(`Timezone: ${status.tz_name}`);
    if (status.time_synced && status.last_sync_epoch) {
        parts.push(`Clock last synced: ${new Date(status.last_sync_epoch * 1000).toLocaleString()}`);
    }
    return parts.join(' · ');
}

async function configureWifi() {
    const ssid = document.getElementById('wifiSsid').value.trim();
    const password = document.getElementById('wifiPassword').value;
    const btn = document.getElementById('wifiConfigureBtn');

    if (!ssid) {
        updateWifiStatusBox('Enter the WiFi network name first.', 'error');
        return;
    }

    btn.disabled = true;
    let statusChar = null;
    let onStatusFrame = null;
    try {
        updateWifiStatusBox('Connecting to grinder…', 'info');
        const conn = await connectWifiChars();
        const { configChar } = conn;
        statusChar = conn.statusChar;

        // Live progress while the grinder tries the network
        let lastStatus = null;
        onStatusFrame = (event) => {
            try {
                lastStatus = JSON.parse(new TextDecoder().decode(event.target.value));
                updateWifiStatusBox(describeWifiStatus(lastStatus), 'info');
            } catch (e) { /* partial/invalid frame; wait for the next one */ }
        };
        await statusChar.startNotifications();
        statusChar.addEventListener('characteristicvaluechanged', onStatusFrame);

        const tz = detectedTz || { rule: '', zoneName: '' };
        const enc = new TextEncoder();
        const fields = [ssid, password, tz.rule, tz.zoneName];
        const encoded = fields.map(f => enc.encode(f));
        const totalLen = 1 + encoded.reduce((n, b) => n + b.length + 1, 0);
        const payload = new Uint8Array(totalLen);
        payload[0] = 0x01;
        let offset = 1;
        for (const bytes of encoded) {
            payload.set(bytes, offset);
            offset += bytes.length;
            payload[offset++] = 0; // NUL terminator
        }
        await configChar.writeValue(payload);
        updateWifiStatusBox('Credentials sent — grinder is trying the network…', 'info');

        // The grinder attempts the connection immediately; wait for a
        // terminal result (sync done or failed), up to ~60s.
        const deadline = Date.now() + 60000;
        let outcome = null;
        while (Date.now() < deadline) {
            await sleep(500);
            const s = lastStatus;
            if (s && s.configured && s.state === 'idle' && s.last_result !== 'none') {
                outcome = s;
                break;
            }
        }

        if (outcome && outcome.last_result === 'success') {
            updateWifiStatusBox(`✓ WiFi set up and clock synced! ${describeWifiStatus(outcome)}`, 'success');
        } else if (outcome) {
            updateWifiStatusBox(`WiFi saved, but the first sync failed. ${describeWifiStatus(outcome)} The grinder keeps retrying on its own.`, 'error');
        } else {
            updateWifiStatusBox('Credentials saved. No result yet — use Check Status in a minute.', 'info');
        }
        const freshest = outcome || lastStatus;
        if (freshest) GrinderSession.applyPatch({ wifi: freshest });
    } catch (error) {
        console.error('WiFi setup error:', error);
        updateWifiStatusBox(`WiFi setup failed: ${error.message}`, 'error');
    } finally {
        if (statusChar) {
            if (onStatusFrame) statusChar.removeEventListener('characteristicvaluechanged', onStatusFrame);
            try { await statusChar.stopNotifications(); } catch (e) { /* best-effort */ }
        }
        GrinderSession.release();
        btn.disabled = false;
    }
}

async function checkWifiStatus() {
    try {
        updateWifiStatusBox('Connecting to grinder…', 'info');
        const conn = await connectWifiChars();
        const value = await conn.statusChar.readValue();
        const status = JSON.parse(new TextDecoder().decode(value));
        updateWifiStatusBox(describeWifiStatus(status), status.time_synced ? 'success' : 'info');
        GrinderSession.applyPatch({ wifi: status });
    } catch (error) {
        console.error('WiFi status error:', error);
        updateWifiStatusBox(`Could not read WiFi status: ${error.message}`, 'error');
    } finally {
        GrinderSession.release();
    }
}

async function forgetWifi() {
    if (!confirm('Remove the stored WiFi credentials from the grinder?')) return;
    try {
        updateWifiStatusBox('Connecting to grinder…', 'info');
        const conn = await connectWifiChars();
        await conn.configChar.writeValue(new Uint8Array([0x02]));
        updateWifiStatusBox('✓ WiFi credentials removed from the grinder.', 'success');
        GrinderSession.applyPatch({ wifi: { configured: false } });
    } catch (error) {
        console.error('WiFi forget error:', error);
        updateWifiStatusBox(`Could not forget WiFi: ${error.message}`, 'error');
    } finally {
        GrinderSession.release();
    }
}
