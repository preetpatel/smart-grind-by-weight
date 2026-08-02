// Session display helpers shared by the hero, tables and views.

import type { ParsedGrindSession } from '@/lib/parser';
import { MODE_MAP } from '@/lib/parser';
import { isEpochTimestamp } from './types';

export function formatUptime(totalSeconds: number): string {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function sessionStartLabel(session: ParsedGrindSession): string {
    const ts = session.session_timestamp;
    if (isEpochTimestamp(ts)) {
        return new Date(ts * 1000).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
    }
    return `${formatUptime(ts)} uptime`;
}

export function sessionTargetLabel(session: ParsedGrindSession): string {
    if (MODE_MAP[session.grind_mode] === 'TIME') {
        return `${(session.target_time_ms / 1000).toFixed(1)}s`;
    }
    return `${session.target_weight.toFixed(1)}g`;
}

export function sessionErrorLabel(session: ParsedGrindSession): string {
    if (MODE_MAP[session.grind_mode] === 'TIME') {
        const seconds = session.time_error_ms / 1000;
        return `${seconds >= 0 ? '+' : ''}${seconds.toFixed(2)}s`;
    }
    const error = session.final_weight - session.target_weight;
    return `${error >= 0 ? '+' : ''}${error.toFixed(2)}g`;
}
