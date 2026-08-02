'use client';

// Plotly wrapper: loads plotly.js on the client only (it's window-bound) and
// re-renders via Plotly.react when the figure changes. All figure objects
// come from the pure builders in lib/analytics/figures.ts.
import { useEffect, useRef } from 'react';
import type { Figure } from '@/lib/analytics/figures';

type PlotlyModule = typeof import('plotly.js-dist-min');

let plotlyPromise: Promise<PlotlyModule> | null = null;
function loadPlotly(): Promise<PlotlyModule> {
    if (!plotlyPromise) {
        plotlyPromise = import('plotly.js-dist-min');
    }
    return plotlyPromise;
}

export function PlotlyChart({ figure, small = false }: { figure: Figure; small?: boolean }) {
    const host = useRef<HTMLDivElement>(null);

    useEffect(() => {
        let cancelled = false;
        const node = host.current;
        if (!node) return;
        loadPlotly()
            .then((Plotly) => {
                if (cancelled || !host.current) return;
                return Plotly.react(host.current, figure.traces, figure.layout, figure.config);
            })
            .catch((error: unknown) => {
                if (node) {
                    node.textContent = `Chart unavailable: ${error instanceof Error ? error.message : String(error)}`;
                }
                console.error('Chart render error:', error);
            });
        return () => {
            cancelled = true;
        };
    }, [figure]);

    // Purge the Plotly instance when the chart unmounts for good.
    useEffect(() => {
        const node = host.current;
        return () => {
            if (node) {
                loadPlotly()
                    .then((Plotly) => Plotly.purge(node))
                    .catch(() => {});
            }
        };
    }, []);

    // Flat: no border, no fill. The figure's own paper_bgcolor matches the
    // page, so the chart reads as part of the document.
    return (
        <div
            ref={host}
            className={small ? 'mb-5 min-h-[20rem] w-full' : 'mb-5 min-h-[28rem] w-full'}
        />
    );
}
