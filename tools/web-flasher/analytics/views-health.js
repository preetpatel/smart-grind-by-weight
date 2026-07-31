// Device Health view: firmware, memory, task performance, hardware status and
// the diagnostic report from the last pull — port of the Streamlit report's
// Device Health mode.

function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else node.setAttribute(key, value);
    }
    for (const child of children) node.appendChild(child);
    return node;
}

function metricTile(label, value, delta = null) {
    const children = [
        el('div', { class: 'metric-label', text: label }),
        el('div', { class: 'metric-value', text: value }),
    ];
    if (delta !== null) children.push(el('div', { class: 'metric-delta', text: delta }));
    return el('div', { class: 'metric' }, children);
}

function section(container, title, tiles) {
    container.appendChild(el('h4', { text: title }));
    container.appendChild(el('div', { class: 'metric-grid' }, tiles));
}

const pad = (n) => String(n).padStart(2, '0');

export function renderDeviceHealth(container, deviceReports) {
    if (!deviceReports || (!deviceReports.system_info && !deviceReports.diagnostics)) {
        container.appendChild(el('div', {
            class: 'status info',
            text: 'No device health snapshot stored. Pull data from the grinder — system info and a '
                + 'diagnostic report are captured automatically with every pull.',
        }));
        return;
    }

    if (deviceReports.captured_at) {
        const captured = new Date(deviceReports.captured_at);
        container.appendChild(el('p', {
            class: 'table-hint',
            text: `Snapshot captured ${Number.isNaN(captured.getTime()) ? deviceReports.captured_at : captured.toLocaleString()} — refreshed on every pull.`,
        }));
    }

    const info = deviceReports.system_info;
    if (info) {
        const system = info.system || {};
        const performance = info.performance || {};
        const hardware = info.hardware || {};
        const sessionStats = info.sessions || {};

        section(container, 'Firmware & System', [
            metricTile('Firmware Version', system.version ?? 'Unknown'),
            metricTile('Build', `#${system.build ?? '?'}`),
            metricTile('Uptime', `${pad(system.uptime_h ?? 0)}:${pad(system.uptime_m ?? 0)}:${pad(system.uptime_s ?? 0)}`),
            metricTile('CPU Frequency', `${system.cpu_freq ?? '?'} MHz`),
        ]);

        section(container, 'Memory', [
            metricTile('Heap Free', `${Math.floor((system.heap_free ?? 0) / 1024).toLocaleString()} KB`),
            metricTile('Heap Total', `${Math.floor((system.heap_total ?? 0) / 1024).toLocaleString()} KB`),
            metricTile('Heap Used', `${(system.heap_used_pct ?? 0).toFixed(1)}%`),
            metricTile('Flash Size', `${Math.floor((system.flash_size ?? 0) / 1024 / 1024).toLocaleString()} MB`),
        ]);

        section(container, 'Task Performance', [
            metricTile('System', performance.system_healthy ? '✅ Healthy' : '⚠️ Stressed'),
            metricTile('Load Cell', `${performance.load_cell_freq_hz ?? 0} Hz`, 'target 40 Hz while grinding'),
            metricTile('Grind Control', `${performance.grind_control_freq_hz ?? 0} Hz`, 'target 50 Hz'),
            metricTile('UI Updates', `${performance.ui_freq_hz ?? 0} Hz`, 'target 20 Hz'),
        ]);

        section(container, 'Hardware', [
            ['Load Cell', hardware.load_cell_active],
            ['Motor', hardware.motor_available],
            ['Display', hardware.display_active],
            ['Touch', hardware.touch_active],
            ['Bluetooth', hardware.ble_enabled],
        ].map(([name, ok]) => metricTile(name, ok ? '✅ OK' : '❌ Fault')));

        section(container, 'Stored Session Data', [
            metricTile('Sessions on Device', String(sessionStats.total_sessions ?? 0)),
            metricTile('Data Available', sessionStats.data_available ? '✅ Yes' : '❌ No'),
            metricTile('Export', sessionStats.export_active ? 'Active' : 'Idle'),
        ]);
    } else {
        container.appendChild(el('div', {
            class: 'status warning',
            text: 'System info was not captured during the last pull. Re-pull with the grinder powered on.',
        }));
    }

    container.appendChild(el('h4', { text: 'Diagnostic Report' }));
    if (deviceReports.diagnostics) {
        const pre = el('pre', { class: 'diagnostics-report', text: deviceReports.diagnostics });
        container.appendChild(pre);

        const download = el('button', { class: 'btn', text: 'Download report' });
        download.style.width = 'auto';
        download.addEventListener('click', () => {
            const blob = new Blob([deviceReports.diagnostics], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const link = el('a', { href: url, download: 'grinder_diagnostics.txt' });
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
        });
        container.appendChild(download);
    } else {
        container.appendChild(el('div', {
            class: 'status warning',
            text: 'No diagnostic report was captured during the last pull.',
        }));
    }
}
