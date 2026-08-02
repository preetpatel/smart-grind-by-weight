// Brew shots and the dial-in verdict, client-side.
//
// The rule mirrors lib/advice.ts on the server (which is what the grinder
// displays): with the shot time fixed, output deviation is a flow-rate signal
// — median of the last ADVICE_WINDOW shots beyond ±ADVICE_THRESHOLD_PCT means
// finer (ran fast) or coarser (choked), at least ADVICE_MIN_SHOTS shots, and a
// recorded grind-setting change resets the evidence. Change one, change both.
import {
    CHART_CONFIG,
    CHART_INK_MUTED,
    COLOR_EVENT,
    COLOR_TARGET,
    COLOR_WEIGHT,
    chartLayout,
    type Figure,
    type PlotlyAnnotation,
    type PlotlyShape,
} from './figures';
import type { Annotation, Bean, BeanAdvice, StoredRecord } from './types';
import { isEpochTimestamp } from './types';

export const ADVICE_MIN_SHOTS = 3;
export const ADVICE_WINDOW = 5;
export const ADVICE_THRESHOLD_PCT = 8;

export interface BrewShot {
    sha256: string;
    sessionId: number;
    timestamp: number;
    doseG: number;
    outputG: number;
    expectedG: number;
    deviationPct: number;
    setting: string | null;
}

// Shots for one bean, oldest → newest (records arrive sorted by session id).
export function brewShots(
    records: StoredRecord[],
    annotations: Map<string, Annotation>,
    bean: Bean,
): BrewShot[] {
    const shots: BrewShot[] = [];
    for (const record of records) {
        const note = annotations.get(record.sha256);
        if (!note || note.bean_id !== bean.id) continue;
        const output = note.brew_output_g;
        const dose = record.session.final_weight;
        if (output == null || !dose || dose <= 0) continue;
        const expected = dose * bean.ratio;
        shots.push({
            sha256: record.sha256,
            sessionId: record.session_id,
            timestamp: record.session.session_timestamp,
            doseG: dose,
            outputG: output,
            expectedG: expected,
            deviationPct: ((output - expected) / expected) * 100,
            setting: note.grind_setting ?? null,
        });
    }
    return shots;
}

// How many grinds are attributed to a bean at all (with or without a brew).
export function beanShotCount(annotations: Map<string, Annotation>, beanId: string): number {
    let count = 0;
    for (const note of annotations.values()) {
        if (note.bean_id === beanId) count++;
    }
    return count;
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const a = sorted[mid] ?? 0;
    const b = sorted[sorted.length % 2 === 0 ? mid - 1 : mid] ?? a;
    return (a + b) / 2;
}

export function adviceForShots(shots: BrewShot[]): BeanAdvice {
    // Walk newest → older, stopping where the recorded setting differs from
    // the newest recorded one (the user already acted on that evidence).
    const newestSetting = [...shots].reverse().find((shot) => shot.setting !== null)?.setting;
    const run: BrewShot[] = [];
    for (let i = shots.length - 1; i >= 0; i--) {
        const shot = shots[i];
        if (!shot) continue;
        if (shot.setting !== null && newestSetting != null && shot.setting !== newestSetting) {
            break;
        }
        run.push(shot);
    }
    const deviations = run.slice(0, ADVICE_WINDOW).map((shot) => shot.deviationPct);
    if (deviations.length < ADVICE_MIN_SHOTS) {
        return { verdict: 'none', shots_considered: deviations.length, median_deviation_pct: null };
    }
    const med = Math.round(median(deviations) * 10) / 10;
    return {
        verdict:
            med > ADVICE_THRESHOLD_PCT ? 'finer' : med < -ADVICE_THRESHOLD_PCT ? 'coarser' : 'ok',
        shots_considered: deviations.length,
        median_deviation_pct: med,
    };
}

function shotDateLabel(shot: BrewShot): string {
    return isEpochTimestamp(shot.timestamp)
        ? new Date(shot.timestamp * 1000).toLocaleDateString(undefined, {
              day: 'numeric',
              month: 'short',
          })
        : `#${shot.sessionId}`;
}

// Deviation per shot against the bean's expected output, with a marker at
// every recorded grind-setting change — the chart that shows a setting change
// fixing a drift, which is the point of recording them.
export function brewDeviationFigure(shots: BrewShot[]): Figure {
    const x = shots.map((_, index) => index + 1);
    const shapes: PlotlyShape[] = [
        {
            type: 'line',
            xref: 'paper',
            x0: 0,
            x1: 1,
            y0: 0,
            y1: 0,
            line: { color: COLOR_TARGET, width: 1, dash: 'dot' },
        },
    ];
    const annotations: PlotlyAnnotation[] = [];
    for (let i = 1; i < shots.length; i++) {
        const previous = shots[i - 1];
        const current = shots[i];
        if (!previous || !current) continue;
        if (
            current.setting !== null &&
            previous.setting !== null &&
            current.setting !== previous.setting
        ) {
            shapes.push({
                type: 'line',
                x0: i + 0.5,
                x1: i + 0.5,
                yref: 'paper',
                y0: 0,
                y1: 1,
                line: { color: COLOR_EVENT, width: 1, dash: 'dash' },
            });
            annotations.push({
                x: i + 0.5,
                yref: 'paper',
                y: 1,
                text: `${previous.setting} → ${current.setting}`,
                showarrow: false,
                font: { size: 10, color: CHART_INK_MUTED },
                yanchor: 'bottom',
            });
        }
    }
    const layout = {
        ...chartLayout('', 'Shot', 'Deviation from expected (%)'),
        shapes,
        annotations,
    };
    return {
        traces: [
            {
                x,
                y: shots.map((shot) => shot.deviationPct),
                type: 'scatter',
                mode: 'lines+markers',
                line: { color: COLOR_WEIGHT, width: 2 },
                marker: { size: 6 },
                customdata: shots.map((shot) => [
                    shotDateLabel(shot),
                    shot.outputG.toFixed(1),
                    shot.expectedG.toFixed(1),
                    shot.doseG.toFixed(1),
                ]),
                hovertemplate:
                    '%{customdata[0]} · %{customdata[3]}g in → %{customdata[1]}g out' +
                    ' (expected %{customdata[2]}g) · %{y:.1f}%<extra></extra>',
            },
        ],
        layout,
        config: CHART_CONFIG,
    };
}

// One sentence for the callout / advice line, or null when there is nothing
// actionable to say.
export function adviceSentence(bean: Bean, advice: BeanAdvice): string | null {
    if (advice.verdict !== 'finer' && advice.verdict !== 'coarser') return null;
    const direction = advice.verdict === 'finer' ? 'running fast' : 'choking';
    const sign = (advice.median_deviation_pct ?? 0) > 0 ? '+' : '';
    return (
        `${bean.name} is ${direction} — median ${sign}${advice.median_deviation_pct}% over the ` +
        `last ${advice.shots_considered} shots. Consider a step ${advice.verdict}.`
    );
}
