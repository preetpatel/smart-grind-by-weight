// Push the active bean to the grinder over BLE — the fast path beside the
// cloud one (the firmware also fetches the same values during its WiFi sync
// window, so a missed push only means the grinder converges later).
//
// Wire format matches the other sysinfo config writes:
//   [0x01][name]\0[ratio]\0[brew_time_s]\0[dose_g]\0[yield_min_g]\0
//         [yield_max_g]\0[time_min_s]\0[time_max_s]\0   set
//   [0x02]                                              clear
//
// Unstated recipe fields go out as 0, which is what the firmware reads as
// "not stated" — and is also what an older firmware, parsing only the first
// three fields, leaves them as.
import * as ble from './ble';

export type BeanPushResult = 'pushed' | 'no-grinder' | 'unsupported';

export interface PushableBean {
    name: string;
    ratio: number;
    brew_time_s: number;
    dose_g?: number | null;
    yield_min_g?: number | null;
    yield_max_g?: number | null;
    time_min_s?: number | null;
    time_max_s?: number | null;
}

function payloadFor(bean: PushableBean | null): Uint8Array {
    if (!bean) return new Uint8Array([0x02]);
    const encoder = new TextEncoder();
    const optional = (value: number | null | undefined) => String(value ?? 0);
    const fields = [
        bean.name,
        String(bean.ratio),
        String(bean.brew_time_s),
        optional(bean.dose_g),
        optional(bean.yield_min_g),
        optional(bean.yield_max_g),
        optional(bean.time_min_s),
        optional(bean.time_max_s),
    ];
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
    bean: PushableBean | null,
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
