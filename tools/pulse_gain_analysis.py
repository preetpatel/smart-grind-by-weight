#!/usr/bin/env python3
"""
Pulse gain analysis - measures how much coffee a correction pulse actually delivers
versus how much the controller predicted it would deliver.

The firmware sizes each correction pulse with the model

    predicted_mass = F * (D - L) / 1000

where F is `pulse_flow_rate` (sampled once, when the motor stops at the end of the
PREDICTIVE phase) and L is the auto-tuned motor response latency.  F is never
re-checked against what the pulses actually deliver, so any error in it persists
for every pulse of the session.

This script recovers the true relationship from logged sessions by regressing the
delivered mass of each pulse against its commanded duration:

    delta_w = m * D + c   ->   b = 1000 * m  (true g/s),  L_hat = -c / m  (ms)

and reports alpha = b / F_used, the ratio of actual to predicted pulse yield.

    alpha ~ 1.0  model is well calibrated, pulses converge in 1-2 attempts
    alpha  < 1.0 pulses under-deliver, error decays geometrically -> extra pulses
    alpha  > 1.0 pulses over-deliver -> overshoot risk on the first correction

Read-only: touches nothing but the exported SQLite database.

Usage:
    python3 tools/pulse_gain_analysis.py
    python3 tools/pulse_gain_analysis.py --db tools/database/grinder_data.db --latency 80
"""

import argparse
import sqlite3
import sys
from pathlib import Path

import numpy as np
import pandas as pd

DEFAULT_DB = Path(__file__).parent / "database" / "grinder_data.db"

# Phases whose end marks a settled, trustworthy weight checkpoint.  Both are only
# left after check_settling_complete() succeeds over a 500ms window.
CHECKPOINT_PHASES = ("PULSE_DECISION", "FINAL_SETTLING")

TERMINATION_TIMEOUT = 1

# A pulse delivering less than this is dominated by settled-weight noise (~+/-0.013g
# for the difference of two 5-sample means at 10 SPS).
MIN_USABLE_DELTA_G = 0.015

# Physically impossible for a <=550ms pulse; indicates a bumped scale or a
# mechanical instability event rather than delivered coffee.
MAX_PLAUSIBLE_DELTA_G = 2.0


def load_tables(db_path):
    if not Path(db_path).exists():
        sys.exit(
            f"error: no database at {db_path}\n"
            "Run 'python3 tools/grinder.py export' first to pull sessions off the device."
        )
    with sqlite3.connect(db_path) as conn:
        sessions = pd.read_sql_query("SELECT * FROM grind_sessions", conn)
        events = pd.read_sql_query("SELECT * FROM grind_events", conn)
        measurements = pd.read_sql_query(
            "SELECT session_id, timestamp_ms, weight_grams FROM grind_measurements", conn
        )
    return sessions, events, measurements


def settled_weight_at(samples, end_ms, tail_ms):
    """Mean weight over the tail_ms ending at end_ms.

    The control loop logs every 20ms but the HX711 only produces a new sample every
    100ms, so this averages roughly tail_ms/100 distinct ADC samples (repeats are
    harmless - they just weight each sample equally).
    """
    window = samples[(samples.timestamp_ms > end_ms - tail_ms) & (samples.timestamp_ms <= end_ms)]
    if window.empty:
        return np.nan
    return float(window.weight_grams.mean())


def build_pulse_table(sessions, events, measurements, tail_ms, include_timeouts):
    """One row per correction pulse: commanded duration, delivered mass, F used."""
    rows = []

    usable = sessions if include_timeouts else sessions[sessions.termination_reason != TERMINATION_TIMEOUT]

    for session_id in usable.session_id:
        ev = events[events.session_id == session_id].sort_values("timestamp_ms")
        samples = measurements[measurements.session_id == session_id]
        if ev.empty or samples.empty:
            continue

        checkpoints = [
            (row.timestamp_ms + row.duration_ms, settled_weight_at(samples, row.timestamp_ms + row.duration_ms, tail_ms))
            for row in ev[ev.phase_name.isin(CHECKPOINT_PHASES)].itertuples()
        ]
        checkpoints = [(t, w) for t, w in checkpoints if not np.isnan(w)]
        if len(checkpoints) < 2:
            continue

        for pulse in ev[ev.phase_name == "PULSE_EXECUTE"].itertuples():
            pulse_start = pulse.timestamp_ms
            pulse_end = pulse.timestamp_ms + pulse.duration_ms

            before = [(t, w) for t, w in checkpoints if t <= pulse_start]
            after = [(t, w) for t, w in checkpoints if t >= pulse_end]
            if not before or not after:
                continue

            delta = after[0][1] - before[-1][1]
            rows.append(
                {
                    "session_id": session_id,
                    "pulse_number": pulse.pulse_attempt_number,
                    "duration_ms": pulse.pulse_duration_ms,
                    "delta_g": delta,
                    "flow_used_gps": pulse.pulse_flow_rate,
                }
            )

    return pd.DataFrame(rows)


def fit_yield_curve(pulses):
    """OLS delta_w = m*D + c.  Returns (b_gps, L_hat_ms, slope_se, r_squared)."""
    d = pulses.duration_ms.to_numpy(dtype=float)
    w = pulses.delta_g.to_numpy(dtype=float)
    n = len(d)

    m, c = np.polyfit(d, w, 1)
    residuals = w - (m * d + c)

    ss_res = float((residuals ** 2).sum())
    ss_tot = float(((w - w.mean()) ** 2).sum())
    r_squared = 1.0 - ss_res / ss_tot if ss_tot > 0 else float("nan")

    # Standard error of the slope
    dof = n - 2
    slope_se = float("nan")
    if dof > 0:
        sxx = float(((d - d.mean()) ** 2).sum())
        if sxx > 0:
            slope_se = float(np.sqrt((ss_res / dof) / sxx))

    b_gps = m * 1000.0
    l_hat = -c / m if m != 0 else float("nan")
    return b_gps, l_hat, slope_se * 1000.0, r_squared


def report(pulses, latency_override):
    print("=" * 72)
    print("PULSE GAIN ANALYSIS")
    print("=" * 72)

    total = len(pulses)
    clean = pulses[
        (pulses.delta_g >= MIN_USABLE_DELTA_G)
        & (pulses.delta_g <= MAX_PLAUSIBLE_DELTA_G)
        & (pulses.duration_ms > 0)
    ]

    print(f"\nPulses found:            {total}")
    print(f"Usable after filtering:  {len(clean)}   "
          f"(dropped {total - len(clean)}: delta outside "
          f"{MIN_USABLE_DELTA_G}-{MAX_PLAUSIBLE_DELTA_G}g)")
    print(f"Sessions represented:    {clean.session_id.nunique()}")

    if len(clean) < 8:
        print("\nNot enough usable pulses to fit anything meaningful.")
        print("Collect ~10 more weight-mode grinds, ideally at a few different")
        print("target weights, then re-export and re-run.")
        return

    duration_spread = float(clean.duration_ms.std())
    print(f"\nCommanded duration D:    mean {clean.duration_ms.mean():6.1f} ms   "
          f"sd {duration_spread:5.1f} ms   "
          f"range {clean.duration_ms.min():.0f}-{clean.duration_ms.max():.0f} ms")
    print(f"Delivered mass:          mean {clean.delta_g.mean():6.3f} g    "
          f"sd {clean.delta_g.std():5.3f} g")

    b_gps, l_hat, slope_se_gps, r_squared = fit_yield_curve(clean)
    f_used = float(clean.flow_used_gps.median())

    print("\n" + "-" * 72)
    print("TWO-PARAMETER FIT   delta_w = b*(D - L)/1000")
    print("-" * 72)
    print(f"  b   (true pulse flow rate)   {b_gps:6.2f} g/s   (+/- {slope_se_gps:.2f} 1 s.e.)")
    print(f"  L   (implied dead time)      {l_hat:6.1f} ms")
    print(f"  R^2                          {r_squared:6.3f}")
    print(f"\n  F used by firmware (median)  {f_used:6.2f} g/s")

    if f_used > 0:
        alpha = b_gps / f_used
        print(f"\n  ALPHA = b / F_used         = {alpha:6.2f}")
        print("\n  " + interpret_alpha(alpha))

    if duration_spread < 30.0:
        print("\n  ! WARNING: commanded durations barely vary (sd < 30ms), so the")
        print("    slope and intercept are poorly separated - L and b trade off")
        print("    against each other and both are unreliable. Treat the two-")
        print("    parameter fit as indicative only and prefer the fixed-L")
        print("    estimate below, or run the controlled sweep (Path B).")

    latency = latency_override if latency_override is not None else l_hat
    source = "supplied" if latency_override is not None else "fitted"
    per_pulse = clean[clean.duration_ms > latency + 40.0].copy()

    if not per_pulse.empty:
        per_pulse["b_gps"] = per_pulse.delta_g / ((per_pulse.duration_ms - latency) / 1000.0)
        per_pulse["alpha"] = per_pulse.b_gps / per_pulse.flow_used_gps

        print("\n" + "-" * 72)
        print(f"PER-PULSE ESTIMATE   (L fixed at {latency:.0f} ms, {source}; "
              f"{len(per_pulse)} pulses with D > L+40ms)")
        print("-" * 72)
        print(f"  alpha  median {per_pulse.alpha.median():.2f}   "
              f"IQR {per_pulse.alpha.quantile(0.25):.2f}-{per_pulse.alpha.quantile(0.75):.2f}")

        # Ramp check: if yield rate climbs with pulse length, a single scalar gain
        # is a linearisation and short pulses are penalised worst.
        if len(per_pulse) >= 12:
            midpoint = per_pulse.duration_ms.median()
            short = per_pulse[per_pulse.duration_ms <= midpoint]
            long = per_pulse[per_pulse.duration_ms > midpoint]
            if not short.empty and not long.empty:
                print(f"\n  Ramp check (is alpha duration-dependent?)")
                print(f"    short pulses (<= {midpoint:.0f} ms):  b = {short.b_gps.median():5.2f} g/s")
                print(f"    long  pulses (>  {midpoint:.0f} ms):  b = {long.b_gps.median():5.2f} g/s")
                if long.b_gps.median() > short.b_gps.median() * 1.15:
                    print("    -> yield rate climbs with duration: output ramps after the")
                    print("       dead time, so a single scalar gain under-serves short pulses.")

    print("\n" + "-" * 72)
    print("PER-SESSION")
    print("-" * 72)
    by_session = clean.groupby("session_id").agg(
        pulses=("delta_g", "size"),
        mean_delta_g=("delta_g", "mean"),
        mean_duration_ms=("duration_ms", "mean"),
        flow_used_gps=("flow_used_gps", "median"),
    )
    print(by_session.to_string())
    print()


def interpret_alpha(alpha):
    if alpha < 0.75:
        return (f"Pulses deliver ~{alpha:.0%} of prediction. Error decays by only "
                f"{1 - alpha:.0%} per pulse,\n  so corrections take many attempts and may hit "
                "the 10-pulse cap and finish light.")
    if alpha > 1.25:
        return (f"Pulses deliver ~{alpha:.0%} of prediction - the first correction "
                "overshoots,\n  which cannot be undone. Closing the loop is a safety fix here, "
                "not just a speed one.")
    return ("Model is roughly calibrated. Closing the pulse loop would buy little; "
            "the\n  remaining error is more likely coming from latency quantisation at 10 SPS.")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--db", default=str(DEFAULT_DB), help="SQLite database (default: tools/database/grinder_data.db)")
    parser.add_argument("--latency", type=float, default=None,
                        help="Motor response latency in ms from the device (Menu > Tune Pulses, "
                             "or the BLE info report). Defaults to the fitted value.")
    parser.add_argument("--tail", type=float, default=400.0,
                        help="Averaging window in ms at each settled checkpoint (default: 400)")
    parser.add_argument("--include-timeouts", action="store_true",
                        help="Include sessions that terminated on timeout (excluded by default)")
    args = parser.parse_args()

    sessions, events, measurements = load_tables(args.db)
    if sessions.empty:
        sys.exit("error: database has no sessions. Run 'python3 tools/grinder.py export' first.")

    pulses = build_pulse_table(sessions, events, measurements, args.tail, args.include_timeouts)
    if pulses.empty:
        sys.exit("error: no correction pulses found. Weight-mode grinds that needed "
                 "no correction produce no pulses to analyse.")

    report(pulses, args.latency)


if __name__ == "__main__":
    main()
