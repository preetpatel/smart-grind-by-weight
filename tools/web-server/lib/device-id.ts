// A grinder's identity is its factory MAC (`ESP.getEfuseMac()`), rendered as
// 12 lowercase hex digits. The firmware puts it in the BLE system-info JSON
// and sends it as `x-device-id` on every cloud request, so both the browser
// and the server can name the same physical grinder without inventing an id.
const DEVICE_ID = /^[0-9a-f]{12}$/;

// Returns the canonical form, or null if this is not a device id. Separators
// are tolerated so a MAC pasted as aa:bb:cc:dd:ee:ff still resolves.
export function normalizeDeviceId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const canonical = value.trim().toLowerCase().replaceAll(/[:-]/g, '');
    return DEVICE_ID.test(canonical) ? canonical : null;
}

export function deviceIdHeader(request: Request): string | null {
    return normalizeDeviceId(request.headers.get('x-device-id'));
}
