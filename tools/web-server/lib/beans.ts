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
        roast_date: row.roastDate,
        notes: row.notes,
        archived: row.archivedAt !== null,
        created_at: row.createdAt.toISOString(),
        updated_at: row.updatedAt.toISOString(),
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
