// Bean payload shaping and field validation, shared by the beans routes and
// the device config/brew endpoints. Wire format is snake_case like the rest of
// the API; DB stays camelCase.
import { ApiError } from './http';
import type { BeanRow } from './schema';

export const BEAN_LIMITS = { name: 120, roastDate: 32, notes: 2000 };
export const MAX_BEANS_PER_STORE = 200;

export interface BeanPayload {
    id: string;
    name: string;
    ratio: number;
    brew_time_s: number;
    dose_g: number | null;
    yield_min_g: number | null;
    yield_max_g: number | null;
    time_min_s: number | null;
    time_max_s: number | null;
    bag_size_g: number | null;
    roast_date: string | null;
    notes: string | null;
    archived: boolean;
    created_at: string;
    updated_at: string;
}

export function toBeanPayload(row: BeanRow): BeanPayload {
    return {
        id: row.id,
        name: row.name,
        ratio: row.ratio,
        brew_time_s: row.brewTimeS,
        dose_g: row.doseG,
        yield_min_g: row.yieldMinG,
        yield_max_g: row.yieldMaxG,
        time_min_s: row.timeMinS,
        time_max_s: row.timeMaxS,
        bag_size_g: row.bagSizeG,
        roast_date: row.roastDate,
        notes: row.notes,
        archived: row.archivedAt !== null,
        created_at: row.createdAt.toISOString(),
        updated_at: row.updatedAt.toISOString(),
    };
}

/**
 * The recipe resolved for a dose actually delivered — the shared definition
 * behind the device's pre-fill, the dashboard's readouts and the advice
 * engine, so all three judge a shot the same way.
 *
 * The yield range is quoted at the bag's reference dose, so a smaller grind
 * targets proportionally less. Time does not scale: it is an absolute the
 * roaster stated, and a shorter shot at the same grind is exactly the signal
 * we are trying to read.
 */
export interface ResolvedRecipe {
    yieldMinG: number;
    yieldMaxG: number;
    yieldStated: boolean;
    timeMinS: number | null;
    timeMaxS: number | null;
}

// Matches USER_BREW_ON_TARGET_BAND_PCT in src/config/user.h.
export const DERIVED_YIELD_TOLERANCE_PCT = 3;

export function resolveRecipe(
    bean: Pick<BeanRow, 'ratio' | 'doseG' | 'yieldMinG' | 'yieldMaxG' | 'timeMinS' | 'timeMaxS'>,
    doseG: number,
): ResolvedRecipe {
    const stated =
        bean.yieldMinG !== null &&
        bean.yieldMaxG !== null &&
        bean.yieldMaxG > bean.yieldMinG &&
        bean.doseG !== null &&
        bean.doseG > 0;

    let yieldMinG: number;
    let yieldMaxG: number;
    if (stated) {
        const scale = doseG / (bean.doseG as number);
        yieldMinG = (bean.yieldMinG as number) * scale;
        yieldMaxG = (bean.yieldMaxG as number) * scale;
    } else {
        const expected = doseG * bean.ratio;
        const tolerance = expected * (DERIVED_YIELD_TOLERANCE_PCT / 100);
        yieldMinG = expected - tolerance;
        yieldMaxG = expected + tolerance;
    }

    // No derived fallback for time on purpose: a band around the pinned
    // brew_time_s would invent a tolerance nobody wrote down, and the advice
    // engine would then read it as if the roaster had.
    const timed = bean.timeMinS !== null && bean.timeMaxS !== null && bean.timeMaxS > bean.timeMinS;

    return {
        yieldMinG,
        yieldMaxG,
        yieldStated: stated,
        timeMinS: timed ? bean.timeMinS : null,
        timeMaxS: timed ? bean.timeMaxS : null,
    };
}

export function isBeanId(value: unknown): value is string {
    return typeof value === 'string' && /^bn_[0-9a-f]{16}$/.test(value);
}

export function trimmedField(value: unknown, max: number): string | null {
    if (typeof value !== 'string') return null;
    const text = value.trim().slice(0, max);
    return text.length ? text : null;
}

export function parseRatio(value: unknown): number {
    const ratio = typeof value === 'number' ? value : Number.NaN;
    if (!Number.isFinite(ratio) || ratio < 0.1 || ratio > 10) {
        throw new ApiError(400, 'ratio must be a number between 0.1 and 10');
    }
    // One espresso-meaningful decimal place; 1.5, not 1.4999999.
    return Math.round(ratio * 100) / 100;
}

export function parseBrewTime(value: unknown): number {
    const seconds = typeof value === 'number' ? value : Number.NaN;
    if (!Number.isInteger(seconds) || seconds < 5 || seconds > 600) {
        throw new ApiError(400, 'brew_time_s must be an integer between 5 and 600');
    }
    return seconds;
}

// What a *shot* reports, as opposed to what a bean recommends. The grinder
// sends 0 when the user skipped the time step, and absent from older firmware
// that never asked — both mean unmeasured, and must stay null. A defaulted
// value here is indistinguishable from a real one downstream, which is exactly
// what made the stored time useless as evidence for advice.
export function parseMeasuredBrewTime(value: unknown): number | null {
    if (value === undefined || value === null || value === 0) return null;
    return parseBrewTime(value);
}

// Recipe fields are all optional and all clearable: null turns the stated
// range back off and the bean falls back to dose x ratio.
export function parseDose(value: unknown): number | null {
    if (value === null) return null;
    const grams = typeof value === 'number' ? value : Number.NaN;
    if (!Number.isFinite(grams) || grams < 1 || grams > 200) {
        throw new ApiError(400, 'dose_g must be a number between 1 and 200, or null');
    }
    return Math.round(grams * 10) / 10;
}

export function parseYieldEdge(value: unknown, field: string): number | null {
    if (value === null) return null;
    const grams = typeof value === 'number' ? value : Number.NaN;
    if (!Number.isFinite(grams) || grams < 1 || grams > 500) {
        throw new ApiError(400, `${field} must be a number between 1 and 500, or null`);
    }
    return Math.round(grams * 10) / 10;
}

export function parseTimeEdge(value: unknown, field: string): number | null {
    if (value === null) return null;
    const seconds = typeof value === 'number' ? value : Number.NaN;
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600) {
        throw new ApiError(400, `${field} must be an integer between 1 and 600, or null`);
    }
    return seconds;
}

/**
 * A range is only meaningful as a pair, and only if it has width — the device
 * and the advice engine both treat max <= min as "not stated", so let the
 * write fail loudly here rather than storing something that silently does
 * nothing. A yield range additionally needs the dose it was quoted at, since
 * that is what scales it to the grind actually delivered.
 */
export function assertRecipeConsistent(recipe: {
    doseG: number | null;
    yieldMinG: number | null;
    yieldMaxG: number | null;
    timeMinS: number | null;
    timeMaxS: number | null;
}): void {
    const yieldPartial = (recipe.yieldMinG === null) !== (recipe.yieldMaxG === null);
    if (yieldPartial) {
        throw new ApiError(400, 'yield_min_g and yield_max_g must be set together, or both null');
    }
    if (recipe.yieldMinG !== null && recipe.yieldMaxG !== null) {
        if (recipe.yieldMaxG <= recipe.yieldMinG) {
            throw new ApiError(400, 'yield_max_g must be greater than yield_min_g');
        }
        if (recipe.doseG === null) {
            throw new ApiError(400, 'dose_g is required when a yield range is set');
        }
    }

    const timePartial = (recipe.timeMinS === null) !== (recipe.timeMaxS === null);
    if (timePartial) {
        throw new ApiError(400, 'time_min_s and time_max_s must be set together, or both null');
    }
    if (
        recipe.timeMinS !== null &&
        recipe.timeMaxS !== null &&
        recipe.timeMaxS <= recipe.timeMinS
    ) {
        throw new ApiError(400, 'time_max_s must be greater than time_min_s');
    }
}

// null clears the size (tracking off); absent means untouched.
export function parseBagSize(value: unknown): number | null {
    if (value === null) return null;
    const grams = typeof value === 'number' ? value : Number.NaN;
    if (!Number.isFinite(grams) || grams < 10 || grams > 10000) {
        throw new ApiError(400, 'bag_size_g must be a number between 10 and 10000, or null');
    }
    return Math.round(grams);
}
