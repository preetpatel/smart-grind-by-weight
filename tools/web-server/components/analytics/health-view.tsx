'use client';

// Device Health view: firmware, memory, task performance, hardware status and
// the diagnostic report from the last pull — React port of the flasher's
// views-health.js (itself a port of the Streamlit report's Device Health mode).

import type { ReactNode } from 'react';
import { MetricTile } from '@/components/analytics/metric';
import { StatusLabel } from '@/components/status-dot';
import { Button } from '@/components/ui/button';
import type { DeviceReports } from '@/lib/analytics/types';

type BadgeKind = 'good' | 'warning' | 'critical';

const BADGE_TONE = { good: 'success', warning: 'caution', critical: 'critical' } as const;

// Dot + label, so state never relies on colour alone.
function StatusBadge({ kind, text }: { kind: BadgeKind; text: string }) {
    return <StatusLabel tone={BADGE_TONE[kind]}>{text}</StatusLabel>;
}

// Metric tile whose value is a prebuilt element (a status badge) rather than
// plain text — same markup/classes as MetricTile in components/ui.tsx.
function BadgeTile({
    label,
    badge,
    delta,
}: {
    label: string;
    badge: ReactNode;
    delta?: string | null;
}) {
    return <MetricTile label={label} value={badge} delta={delta} />;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
    return (
        <>
            <h2 className="mt-8 mb-1 font-medium text-base">{title}</h2>
            <div className="my-4 grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-3 lg:grid-cols-5">
                {children}
            </div>
        </>
    );
}

const pad = (value: unknown): string => String(value ?? 0).padStart(2, '0');

// Loosely-typed snapshot fields: mirror the original's `?? fallback` inside a
// template literal (nullish fallback, otherwise String coercion).
function text(value: unknown, fallback: string): string {
    return value === null || value === undefined ? fallback : String(value);
}

// Mirror the original's `(value ?? 0)` followed by arithmetic.
function num(value: unknown): number {
    return Number(value ?? 0);
}

function SystemInfoSections({ info }: { info: NonNullable<DeviceReports['system_info']> }) {
    const system: Record<string, unknown> = info.system ?? {};
    const performance: Record<string, unknown> = info.performance ?? {};
    const hardware: Record<string, unknown> = info.hardware ?? {};
    const sessionStats: Record<string, unknown> = info.sessions ?? {};

    const clockTile = system.time_synced ? (
        <BadgeTile
            label="Device Clock"
            badge={<StatusBadge kind="good" text="SYNCED" />}
            delta={system.epoch ? new Date(num(system.epoch) * 1000).toLocaleString() : null}
        />
    ) : (
        <BadgeTile label="Device Clock" badge={<StatusBadge kind="warning" text="NOT SYNCED" />} />
    );

    const hardwareTiles: readonly [string, unknown][] = [
        ['Load Cell', hardware.load_cell_active],
        ['Motor', hardware.motor_available],
        ['Display', hardware.display_active],
        ['Touch', hardware.touch_active],
        ['Bluetooth', hardware.ble_enabled],
    ];

    const fsTotalKb = num(sessionStats.fs_total_kb);
    const fsUsedKb = num(sessionStats.fs_used_kb);

    return (
        <>
            <Section title="Firmware & System">
                <MetricTile label="Firmware Version" value={text(system.version, 'Unknown')} />
                <MetricTile label="Build" value={`#${text(system.build, '?')}`} />
                <MetricTile
                    label="Uptime"
                    value={`${pad(system.uptime_h)}:${pad(system.uptime_m)}:${pad(system.uptime_s)}`}
                />
                <MetricTile label="CPU Frequency" value={`${text(system.cpu_freq, '?')} MHz`} />
                {clockTile}
            </Section>

            <Section title="Memory">
                <MetricTile
                    label="Heap Free"
                    value={`${Math.floor(num(system.heap_free) / 1024).toLocaleString()} KB`}
                />
                <MetricTile
                    label="Heap Total"
                    value={`${Math.floor(num(system.heap_total) / 1024).toLocaleString()} KB`}
                />
                <MetricTile label="Heap Used" value={`${num(system.heap_used_pct).toFixed(1)}%`} />
                <MetricTile
                    label="Flash Size"
                    value={`${Math.floor(num(system.flash_size) / 1024 / 1024).toLocaleString()} MB`}
                />
            </Section>

            <Section title="Task Performance">
                <BadgeTile
                    label="System"
                    badge={
                        performance.system_healthy ? (
                            <StatusBadge kind="good" text="HEALTHY" />
                        ) : (
                            <StatusBadge kind="warning" text="STRESSED" />
                        )
                    }
                />
                <MetricTile
                    label="Load Cell"
                    value={`${text(performance.load_cell_freq_hz, '0')} Hz`}
                    delta="target 40 Hz while grinding"
                />
                <MetricTile
                    label="Grind Control"
                    value={`${text(performance.grind_control_freq_hz, '0')} Hz`}
                    delta="target 50 Hz"
                />
                <MetricTile
                    label="UI Updates"
                    value={`${text(performance.ui_freq_hz, '0')} Hz`}
                    delta="target 20 Hz"
                />
            </Section>

            <Section title="Hardware">
                {hardwareTiles.map(([name, ok]) => (
                    <BadgeTile
                        key={name}
                        label={name}
                        badge={
                            ok ? (
                                <StatusBadge kind="good" text="OK" />
                            ) : (
                                <StatusBadge kind="critical" text="FAULT" />
                            )
                        }
                    />
                ))}
            </Section>

            <Section title="Stored Grinds">
                {sessionStats.logging_enabled !== undefined && (
                    <BadgeTile
                        label="Grind Logging"
                        badge={
                            sessionStats.logging_enabled ? (
                                <StatusBadge kind="good" text="ON" />
                            ) : (
                                <StatusBadge kind="warning" text="OFF" />
                            )
                        }
                        delta={sessionStats.logging_enabled ? null : 'not recording'}
                    />
                )}
                <MetricTile
                    label="Grinds on Device"
                    value={String(sessionStats.total_sessions ?? 0)}
                />
                <BadgeTile
                    label="Data Available"
                    badge={
                        sessionStats.data_available ? (
                            <StatusBadge kind="good" text="YES" />
                        ) : (
                            <StatusBadge kind="critical" text="NO" />
                        )
                    }
                />
                <MetricTile label="Export" value={sessionStats.export_active ? 'Active' : 'Idle'} />
                {Boolean(sessionStats.fs_total_kb) && (
                    <MetricTile
                        label="Storage"
                        value={`${((fsUsedKb / fsTotalKb) * 100).toFixed(0)}%`}
                        delta={`${fsUsedKb.toLocaleString()} / ${fsTotalKb.toLocaleString()} KB`}
                    />
                )}
            </Section>
        </>
    );
}

function DiagnosticsReport({ diagnostics }: { diagnostics: string }) {
    const download = () => {
        const blob = new Blob([diagnostics], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'grinder_diagnostics.txt';
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
    };

    return (
        <>
            <pre className="max-h-[32rem] overflow-auto rounded-2xl border bg-card px-4 py-3 font-mono text-muted-foreground text-xs whitespace-pre-wrap">
                {diagnostics}
            </pre>
            <Button variant="outline" size="sm" onClick={download}>
                Download report
            </Button>
        </>
    );
}

export function HealthView({ deviceReports }: { deviceReports: DeviceReports | null }) {
    if (!deviceReports || (!deviceReports.system_info && !deviceReports.diagnostics)) {
        return <div className="my-4 text-muted-foreground text-sm">No health snapshot yet.</div>;
    }

    const captured = new Date(deviceReports.captured_at);
    const capturedLabel = Number.isNaN(captured.getTime())
        ? deviceReports.captured_at
        : captured.toLocaleString();

    return (
        <>
            {deviceReports.captured_at && (
                <p className="mb-3 text-muted-foreground text-xs">Captured {capturedLabel}</p>
            )}

            {deviceReports.system_info ? (
                <SystemInfoSections info={deviceReports.system_info} />
            ) : (
                <div className="my-4 text-caution text-sm">
                    System info was not captured in the last pull.
                </div>
            )}

            <h2 className="mt-8 mb-1 font-medium text-base">Diagnostic Report</h2>
            {deviceReports.diagnostics ? (
                <DiagnosticsReport diagnostics={deviceReports.diagnostics} />
            ) : (
                <div className="my-4 text-caution text-sm">
                    No diagnostic report in the last pull.
                </div>
            )}
        </>
    );
}
