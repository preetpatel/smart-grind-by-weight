// Push the active bean to the grinder over BLE — the fast path beside the
// cloud one (the firmware also fetches the same values during its WiFi sync
// window, so a missed push only means the grinder converges later).
//
// Wire format matches the other sysinfo config writes:
//   [0x01][name]\0[ratio]\0[brew_time_s]\0   set
//   [0x02]                                   clear
import * as ble from './ble';

export type BeanPushResult = 'pushed' | 'no-grinder' | 'unsupported';

function payloadFor(bean: { name: string; ratio: number; brew_time_s: number } | null): Uint8Array {
    if (!bean) return new Uint8Array([0x02]);
    const encoder = new TextEncoder();
    const fields = [bean.name, String(bean.ratio), String(bean.brew_time_s)];
    const parts = fields.map((field) => encoder.encode(field));
    const total = 1 + parts.reduce((sum, part) => sum + part.length + 1, 0);
    const payload = new Uint8Array(total);
    payload[0] = 0x01;
    let offset = 1;
    for (const part of parts) {
        payload.set(part, offset);
        offset += part.length + 1; // trailing NUL is already zero
    }
    return payload;
}

export async function pushBeanToGrinder(
    bean: { name: string; ratio: number; brew_time_s: number } | null,
    { interactive = false } = {},
): Promise<BeanPushResult> {
    if (!ble.isSupported()) return 'no-grinder';
    try {
        await ble.connect({ interactive });
    } catch {
        return 'no-grinder';
    }
    try {
        const service = await ble.getService(ble.UUIDS.SYSINFO_SERVICE);
        const characteristic = await service.getCharacteristic(ble.UUIDS.SYSINFO_BEAN_CONFIG);
        await characteristic.writeValue(payloadFor(bean) as BufferSource);
        return 'pushed';
    } catch {
        // The service is present on every firmware; the characteristic only
        // exists once the grinder runs a build that knows about beans.
        return 'unsupported';
    } finally {
        ble.release();
    }
}
