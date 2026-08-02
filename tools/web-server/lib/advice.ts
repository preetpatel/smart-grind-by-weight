// Grind advice: with the shot time fixed per bean, output deviation is a
// flow-rate signal. Over-delivery means the shot ran fast (too coarse → try
// finer); under-delivery means it choked (too fine → try coarser). Computed
// server-side so the thresholds can evolve without a firmware release — the
// grinder only displays the verdict.
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { type BeanPayload, toBeanPayload } from './beans';
import type { Db } from './db';
import { annotations, type BeanRow, beans, type Store, sessions } from './schema';

export type AdviceVerdict = 'finer' | 'coarser' | 'ok' | 'none';

export interface Advice {
    verdict: AdviceVerdict;
    shots_considered: number;
    median_deviation_pct: number | null;
}

export const NO_ADVICE: Advice = {
    verdict: 'none',
    shots_considered: 0,
    median_deviation_pct: null,
};

const MIN_SHOTS = 3;
const WINDOW = 5;
const THRESHOLD_PCT = 8;

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const a = sorted[mid] ?? 0;
    const b = sorted[sorted.length % 2 === 0 ? mid - 1 : mid] ?? a;
    return (a + b) / 2;
}

export async function computeAdvice(db: Db, storeId: string, bean: BeanRow): Promise<Advice> {
    // Newest brews for this bean, joined to the dose each grind delivered.
    // Ordered by arrival: uploads follow grinds within a minute when WiFi is
    // up, and session_timestamp mixes epochs with uptime seconds on
    // never-synced clocks, so receivedAt is the honest ordering.
    const rows = await db
        .select({
            output: annotations.brewOutputG,
            setting: annotations.grindSetting,
            dose: sessions.finalWeight,
        })
        .from(annotations)
        .innerJoin(
            sessions,
            and(eq(sessions.storeId, annotations.storeId), eq(sessions.sha256, annotations.sha256)),
        )
        .where(
            and(
                eq(annotations.storeId, storeId),
                eq(annotations.beanId, bean.id),
                isNotNull(annotations.brewOutputG),
            ),
        )
        .orderBy(desc(sessions.receivedAt), desc(sessions.id))
        .limit(20);

    // A grind-setting change resets the evidence: the user already acted, so
    // only shots on the current setting count. Walk newest → older and stop at
    // the first row whose recorded setting differs from the newest recorded
    // one; rows with no setting recorded ride along with their neighbours.
    const currentSetting = rows.find((row) => row.setting !== null)?.setting ?? null;
    const run: typeof rows = [];
    for (const row of rows) {
        if (row.setting !== null && currentSetting !== null && row.setting !== currentSetting) {
            break;
        }
        run.push(row);
    }

    const deviations = run
        .slice(0, WINDOW)
        .filter((row) => row.output !== null && row.dose !== null && row.dose > 0)
        .map((row) => {
            const expected = (row.dose as number) * bean.ratio;
            return (((row.output as number) - expected) / expected) * 100;
        });

    if (deviations.length < MIN_SHOTS) {
        return { verdict: 'none', shots_considered: deviations.length, median_deviation_pct: null };
    }

    const med = Math.round(median(deviations) * 10) / 10;
    const verdict: AdviceVerdict =
        med > THRESHOLD_PCT ? 'finer' : med < -THRESHOLD_PCT ? 'coarser' : 'ok';
    return { verdict, shots_considered: deviations.length, median_deviation_pct: med };
}

export interface DeviceConfig {
    bean: BeanPayload | null;
    advice: Advice;
}

// What the grinder needs from the cloud: the active bag and the current
// verdict. Served by GET /config and echoed by POST /brews so the device gets
// fresh advice in the same round trip that delivered a brew record.
export async function deviceConfig(db: Db, store: Store): Promise<DeviceConfig> {
    if (!store.activeBeanId) return { bean: null, advice: NO_ADVICE };
    const rows = await db
        .select()
        .from(beans)
        .where(and(eq(beans.storeId, store.id), eq(beans.id, store.activeBeanId)));
    const bean = rows[0];
    if (!bean) return { bean: null, advice: NO_ADVICE };
    return { bean: toBeanPayload(bean), advice: await computeAdvice(db, store.id, bean) };
}
