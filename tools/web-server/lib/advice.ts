// Grind advice, computed server-side so the thresholds can evolve without a
// firmware release — the grinder only displays the verdict.
//
// Two readings, depending on what the bag states and what the user measured.
//
// Where the bag gives a target time and the shot was actually timed, time is
// the signal, which is the classic dial-in loop: hold the dose and the yield,
// and let the clock say whether the grind is too fine or too coarse. A shot
// stopped short of the yield band would read as fast for the wrong reason, so
// the time is first normalised to what it would have been at the middle of the
// band at the same average flow.
//
// Otherwise it falls back to the original reading: with the time assumed
// fixed, output deviation is a flow-rate proxy — over-delivery means the shot
// ran fast (too coarse → finer), under-delivery means it choked (→ coarser).
// That assumption is why an unmeasured time must never be stored as a default:
// it would enter the time-based path as evidence nobody produced.
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { type BeanPayload, resolveRecipe, toBeanPayload } from './beans';
import type { Db } from './db';
import { annotations, type BeanRow, beans, type Store, sessions } from './schema';

export type AdviceVerdict = 'finer' | 'coarser' | 'ok' | 'none';
export type AdviceBasis = 'time' | 'yield';

export interface Advice {
    verdict: AdviceVerdict;
    shots_considered: number;
    median_deviation_pct: number | null;
    // Which reading produced the verdict, so the dashboard can say what it is
    // looking at rather than implying both are the same measurement.
    basis: AdviceBasis;
}

export const NO_ADVICE: Advice = {
    verdict: 'none',
    shots_considered: 0,
    median_deviation_pct: null,
    basis: 'yield',
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
            time: annotations.brewTimeS,
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

    const usable = run.filter(
        (row) => row.output !== null && row.output > 0 && row.dose !== null && row.dose > 0,
    );

    // Time is only the signal where the bag stated a target and the shots were
    // actually timed. Mixing timed and untimed shots into one median would let
    // the untimed ones vote on a question they never answered, so the timed
    // reading is used only when the window is timed throughout.
    const timedRun = usable
        .slice(0, WINDOW)
        .filter((row) => row.time !== null && row.time > 0)
        .map((row) => {
            const dose = row.dose as number;
            const output = row.output as number;
            const recipe = resolveRecipe(bean, dose);
            if (recipe.timeMinS === null || recipe.timeMaxS === null) return null;
            // What the shot would have taken to reach the middle of the yield
            // band at the flow it actually ran, so stopping short or running
            // long doesn't masquerade as a grind problem.
            const targetYield = (recipe.yieldMinG + recipe.yieldMaxG) / 2;
            const normalised = (row.time as number) * (targetYield / output);
            const mid = ((recipe.timeMinS as number) + (recipe.timeMaxS as number)) / 2;
            return {
                normalised,
                mid,
                lo: recipe.timeMinS as number,
                hi: recipe.timeMaxS as number,
            };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    if (timedRun.length >= MIN_SHOTS) {
        const med = median(timedRun.map((entry) => entry.normalised));
        const { lo, hi, mid } = timedRun[0] as (typeof timedRun)[number];
        // A short shot means the water met too little resistance: grind finer.
        const verdict: AdviceVerdict = med < lo ? 'finer' : med > hi ? 'coarser' : 'ok';
        return {
            verdict,
            shots_considered: timedRun.length,
            median_deviation_pct: Math.round(((med - mid) / mid) * 1000) / 10,
            basis: 'time',
        };
    }

    const deviations = usable.slice(0, WINDOW).map((row) => {
        const expected = (row.dose as number) * bean.ratio;
        return (((row.output as number) - expected) / expected) * 100;
    });

    if (deviations.length < MIN_SHOTS) {
        return {
            verdict: 'none',
            shots_considered: deviations.length,
            median_deviation_pct: null,
            basis: 'yield',
        };
    }

    const med = Math.round(median(deviations) * 10) / 10;
    const verdict: AdviceVerdict =
        med > THRESHOLD_PCT ? 'finer' : med < -THRESHOLD_PCT ? 'coarser' : 'ok';
    return {
        verdict,
        shots_considered: deviations.length,
        median_deviation_pct: med,
        basis: 'yield',
    };
}

// How much of the bag is left, in the unit the user thinks in: shots. The
// dose per shot is the median of the bag's recent grinds (they pull the same
// double every time), falling back to a plausible double until data exists.
// Purge-mode waste isn't in the session summary, so the estimate runs a
// touch optimistic — the low threshold absorbs that.
export interface BagStats {
    size_g: number | null;
    used_g: number;
    shots_remaining: number | null;
    low: boolean;
}

export const NO_BAG: BagStats = { size_g: null, used_g: 0, shots_remaining: null, low: false };

const LOW_SHOTS_THRESHOLD = 5;
const FALLBACK_DOSE_G = 18;

export async function computeBagStats(db: Db, storeId: string, bean: BeanRow): Promise<BagStats> {
    const doseFilter = and(
        eq(annotations.storeId, storeId),
        eq(annotations.beanId, bean.id),
        isNotNull(sessions.finalWeight),
    );
    const joined = and(
        eq(sessions.storeId, annotations.storeId),
        eq(sessions.sha256, annotations.sha256),
    );
    const totals = await db
        .select({ used: sql<number>`coalesce(sum(${sessions.finalWeight}), 0)` })
        .from(annotations)
        .innerJoin(sessions, joined)
        .where(doseFilter);
    const used = Math.round((totals[0]?.used ?? 0) * 10) / 10;
    if (!bean.bagSizeG) return { ...NO_BAG, used_g: used };

    const recent = await db
        .select({ dose: sessions.finalWeight })
        .from(annotations)
        .innerJoin(sessions, joined)
        .where(doseFilter)
        .orderBy(desc(sessions.receivedAt), desc(sessions.id))
        .limit(10);
    const doses = recent
        .map((row) => row.dose)
        .filter((dose): dose is number => dose !== null && dose > 1);
    const typicalDose = doses.length ? median(doses) : FALLBACK_DOSE_G;

    const remaining = Math.max(0, bean.bagSizeG - used);
    const shots = Math.floor(remaining / typicalDose);
    return {
        size_g: bean.bagSizeG,
        used_g: used,
        shots_remaining: shots,
        low: shots <= LOW_SHOTS_THRESHOLD,
    };
}

export interface DeviceConfig {
    bean: BeanPayload | null;
    advice: Advice;
    bag: BagStats;
}

// What the grinder needs from the cloud: the active bag and the current
// verdict. Served by GET /config and echoed by POST /brews so the device gets
// fresh advice in the same round trip that delivered a brew record.
export async function deviceConfig(db: Db, store: Store): Promise<DeviceConfig> {
    if (!store.activeBeanId) return { bean: null, advice: NO_ADVICE, bag: NO_BAG };
    const rows = await db
        .select()
        .from(beans)
        .where(and(eq(beans.storeId, store.id), eq(beans.id, store.activeBeanId)));
    const bean = rows[0];
    if (!bean) return { bean: null, advice: NO_ADVICE, bag: NO_BAG };
    return {
        bean: toBeanPayload(bean),
        advice: await computeAdvice(db, store.id, bean),
        bag: await computeBagStats(db, store.id, bean),
    };
}
