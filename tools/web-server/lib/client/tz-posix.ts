// Derives a POSIX TZ rule string (e.g. "STD-12DST-13,M9.5.0/2,M4.1.0/3") for
// the browser's timezone, so the grinder can compute DST transitions locally
// forever without a network lookup or a bundled zone table.
//
// The browser already knows the zone's UTC offset at any instant via Intl.
// Sampling the current year finds the standard/DST offsets and the two
// transition instants; each transition is then expressed in the POSIX
// "Mmonth.week.day/hour" form the ESP32's C library understands. Generic
// "STD"/"DST" abbreviations are used - the device never displays them, and
// real abbreviations aren't reliably available cross-browser.
//
// Zones without DST produce a plain fixed-offset rule ("STD-13"). If a zone
// somehow has more than two transitions in the year (historic oddities), the
// current fixed offset is used as a safe fallback - the clock stays right
// until the flasher next connects.

export interface PosixTz {
    rule: string;
    zoneName: string;
}

// Minutes east of UTC for `date` in `timeZone`.
function offsetMinutesAt(date: Date, timeZone: string): number {
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
    const parts: Record<string, string> = {};
    for (const { type, value } of dtf.formatToParts(date)) {
        parts[type] = value;
    }
    // "24" can appear for midnight with hour12:false
    const hour = parts.hour === '24' ? 0 : Number(parts.hour);
    const asUtc = Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        hour,
        Number(parts.minute),
        Number(parts.second),
    );
    return Math.round((asUtc - date.getTime()) / 60000);
}

// POSIX offsets are seconds *west* of UTC: UTC+13 -> "-13", UTC-9:30 -> "9:30".
function posixOffset(minutesEast: number): string {
    const west = -minutesEast;
    const sign = west < 0 ? '-' : '';
    const abs = Math.abs(west);
    const h = Math.floor(abs / 60);
    const m = abs % 60;
    return m === 0 ? `${sign}${h}` : `${sign}${h}:${String(m).padStart(2, '0')}`;
}

// Binary-searches the minute at which the offset changes between two instants
// known to differ. Returns the first Date at the new offset.
function findTransition(before: Date, after: Date, timeZone: string): Date {
    let lo = before.getTime();
    let hi = after.getTime();
    const target = offsetMinutesAt(after, timeZone);
    while (hi - lo > 60000) {
        const mid = lo + Math.floor((hi - lo) / 2 / 60000) * 60000;
        if (offsetMinutesAt(new Date(mid), timeZone) === target) {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    return new Date(hi);
}

// Expresses a transition instant as a POSIX "Mm.w.d/h" rule component. The
// rule time is the local wall-clock time in effect *before* the transition.
function posixRuleFor(transition: Date, offsetBeforeMin: number): string {
    const local = new Date(transition.getTime() + offsetBeforeMin * 60000);
    const month = local.getUTCMonth() + 1;
    const day = local.getUTCDate();
    const weekday = local.getUTCDay(); // 0 = Sunday, matching POSIX
    const daysInMonth = new Date(Date.UTC(local.getUTCFullYear(), month, 0)).getUTCDate();
    // Occurrence of this weekday within the month; 5 means "last"
    let week = Math.ceil(day / 7);
    if (day + 7 > daysInMonth) week = 5;
    const hour = local.getUTCHours();
    const minute = local.getUTCMinutes();
    const time = minute === 0 ? `${hour}` : `${hour}:${String(minute).padStart(2, '0')}`;
    return `M${month}.${week}.${weekday}/${time}`;
}

// Returns { rule, zoneName } for the browser's current timezone.
export function detectPosixTz(): PosixTz {
    const zoneName = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    const now = new Date();
    const year = now.getUTCFullYear();

    // Sample twice a month; DST shifts always span multiple weeks, so a
    // transition can't hide between samples.
    const samples: Array<{ date: Date; offset: number }> = [];
    for (let month = 0; month < 12; month++) {
        for (const day of [1, 15]) {
            const d = new Date(Date.UTC(year, month, day, 12, 0, 0));
            samples.push({ date: d, offset: offsetMinutesAt(d, zoneName) });
        }
    }
    const nextYear = new Date(Date.UTC(year + 1, 0, 1, 12, 0, 0));
    samples.push({ date: nextYear, offset: offsetMinutesAt(nextYear, zoneName) });

    const offsets = [...new Set(samples.map((s) => s.offset))];
    if (offsets.length === 1) {
        return { rule: `STD${posixOffset(offsets[0] ?? 0)}`, zoneName };
    }

    // DST offset is the larger (further east) of the two
    const stdOffset = Math.min(...offsets);
    const dstOffset = Math.max(...offsets);

    const transitions: Array<{ at: Date; from: number; to: number }> = [];
    for (let i = 1; i < samples.length; i++) {
        const prev = samples[i - 1];
        const curr = samples[i];
        if (prev && curr && curr.offset !== prev.offset) {
            transitions.push({
                at: findTransition(prev.date, curr.date, zoneName),
                from: prev.offset,
                to: curr.offset,
            });
        }
    }

    const toDst = transitions.find((t) => t.to === dstOffset);
    const toStd = transitions.find((t) => t.to === stdOffset);
    if (offsets.length !== 2 || !toDst || !toStd) {
        // Odd zone; pin to today's offset rather than guessing rules
        const current = offsetMinutesAt(now, zoneName);
        return { rule: `STD${posixOffset(current)}`, zoneName };
    }

    const startRule = posixRuleFor(toDst.at, toDst.from);
    const endRule = posixRuleFor(toStd.at, toStd.from);
    const rule = `STD${posixOffset(stdOffset)}DST${posixOffset(dstOffset)},${startRule},${endRule}`;
    return { rule, zoneName };
}
