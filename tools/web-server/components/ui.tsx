'use client';

// Small shared primitives matching the design system in app/globals.css.
// Class names are the flasher's originals so the whole app reads as one
// system (status boxes, metric tiles, sub-tabs, badges).

export type StatusKind = 'info' | 'success' | 'error' | 'warning';

export interface StatusMessage {
    text: string;
    kind: StatusKind;
}

export function StatusBox({ status }: { status: StatusMessage | null }) {
    if (!status?.text) return null;
    return <div className={`status ${status.kind}`}>{status.text}</div>;
}

export function ProgressBar({ percent }: { percent: number | null }) {
    if (percent === null) return null;
    return (
        <div className="progress data">
            <div className="progress-bar" style={{ width: `${Math.min(100, percent)}%` }} />
        </div>
    );
}

export function MetricTile({
    label,
    value,
    delta,
    deltaClass = '',
}: {
    label: string;
    value: string;
    delta?: string | null;
    deltaClass?: '' | 'good' | 'bad';
}) {
    return (
        <div className="metric">
            <div className="metric-label">{label}</div>
            <div className="metric-value">{value}</div>
            {delta != null && <div className={`metric-delta ${deltaClass}`}>{delta}</div>}
        </div>
    );
}

export function SubTabs<T extends string>({
    tabs,
    active,
    onChange,
    deviceNav = false,
}: {
    tabs: readonly { key: T; label: string }[];
    active: T;
    onChange: (key: T) => void;
    deviceNav?: boolean;
}) {
    return (
        <div className={`sub-tabs ${deviceNav ? 'device-nav' : ''}`}>
            {tabs.map((tab) => (
                <button
                    key={tab.key}
                    type="button"
                    className={`sub-tab ${active === tab.key ? 'active' : ''}`}
                    onClick={() => onChange(tab.key)}
                >
                    {tab.label}
                </button>
            ))}
        </div>
    );
}

const BADGE_KIND: Record<string, string> = {
    COMPLETE: 'good',
    OVERSHOOT: 'warning',
    MAX_PULSES: 'serious',
    TIMEOUT: 'critical',
};

export function ResultBadge({ status }: { status: string }) {
    return <span className={`badge st-${BADGE_KIND[status] ?? 'neutral'}`}>{status}</span>;
}
