# Correctness and Performance Audit

Date: 2026-07-26

Branch: `codex/correctness-performance-audit`

Base: `0ebeeb7` (`fix: misc changes`)

## Scope

Review the motor-control, weight-sampling, calibration, grind-control, and
auto-tune paths for correctness, grind accuracy, and performance. Changes are
limited to defects with a clear impact; broad refactors and speculative tuning
are out of scope.

Hardware and USB debugging are not currently available. Evidence therefore
comes from source inspection, deterministic host checks, and production,
debug, and mock firmware builds. On-device validation remains explicitly
listed below.

## Baseline

Before source changes:

- Production firmware build 29 passed.
- Debug firmware build 30 passed.
- Mock firmware build 31 passed.
- BLE host tests passed: 2 of 2.
- Python tool compilation passed.
- Production RAM: 67,688 bytes; flash: 2,186,035 bytes.
- Debug RAM: 67,688 bytes; flash: 2,273,867 bytes.
- Mock RAM: 67,744 bytes; flash: 2,273,051 bytes.

## Stage 1: Deterministic motor pulses and safe auto-tune

### Findings

1. Long RMT pulses were encoded by looping a compound symbol. The loop repeated
   both the full-duration portion and the remainder, so requested and delivered
   motor-on times diverged substantially. Examples from the original formula:

   | Requested | Encoded HIGH | Error |
   | ---: | ---: | ---: |
   | 100 ms | 68.932 ms | -31.068 ms |
   | 300 ms | 302.912 ms | +2.912 ms |
   | 550 ms | 877.425 ms | +327.425 ms |
   | 1,000 ms | 1,442.953 ms | +442.953 ms |

2. Finite and continuous RMT payloads were local stack arrays. The ESP-IDF RMT
   API requires asynchronous transmit payloads to remain valid until the
   transaction completes.
3. Mock correction and auto-tune pulses notified the simulated load cell in
   both `Grinder` and the calling controller, doubling simulated delivery.
4. Canceling auto-tune did not immediately stop an active motor pulse.
5. Verification could increment a candidate beyond the configured 300 ms
   maximum and then report success even though the value would not be saved.
6. Failure reporting said the default latency was used, while the stored
   previous latency was actually retained.

### Changes and rationale

- Split pulse duration into exact, non-looped RMT symbols and set the explicit
  end-of-transmission output level LOW.
- Store both finite and continuous RMT payloads in `Grinder`, preserving their
  lifetime for asynchronous transmission.
- Poll the RMT driver's transaction-completion state with a zero-timeout call
  instead of inferring completion from a GPIO read. (Superseded in stage 3 by
  the transmit-done callback, which does not log on every poll.)
- Reject zero or unsupported durations and leave grinder state inactive when
  encoder creation or transmission fails.
- Keep mock pulse notification in `Grinder`, the single hardware-abstraction
  owner.
- Stop an in-flight pulse immediately on auto-tune cancellation or failure.
- Enforce the configured auto-tune range before retrying, saving, or reporting
  success.
- Preserve and accurately report the previous latency on auto-tune failure.
- Handle the previously omitted priming state explicitly.

### Verification

- A host C++ regression check exhaustively verifies every requested duration
  from 0 through 1,000,000 microseconds, including all RMT boundaries.
- Production build 32 passed: RAM 67,752 bytes; flash 2,187,159 bytes.
- Debug build 33 passed: RAM 67,752 bytes; flash 2,274,999 bytes.
- Mock build 34 passed: RAM 67,808 bytes; flash 2,273,487 bytes.
- Source scan confirms one mock pulse notification call site, owned by
  `Grinder`.
- Stage cost versus baseline: 64 bytes RAM. The production flash increase is
  1,124 bytes.

## Stage 2: Grind-flow and calibration accuracy

### Findings

1. The default load-cell calibration factor is negative. Raw flow rates were
   sorted in ascending order before selecting the 95th percentile, but dividing
   by a negative factor reverses that order. A representative set therefore
   returned 1.00 g/s instead of the true calibrated 95th-percentile value of
   3.00 g/s. Underestimating flow can lengthen correction pulses and increase
   overshoot.
2. Calibration ran on the UI core but directly invoked an HX711 update while
   the sampling task owned the same bit-banged device on Core 0. The direct
   result was not used.
3. Tare and calibration cleared sample and noise rings on the UI core while
   Core 0 could append to them.
4. Calibration accepted an unsettled timeout, an empty sample set, and an
   implausibly small ADC delta as if it had succeeded. The UI advanced even
   when no valid factor was saved.
5. A blocking tare timeout left the request armed, allowing it to alter the
   zero point later after the UI had already reported completion.
6. Sample-window comparisons used absolute timestamp ordering. After the
   32-bit `millis()` counter rolled over, recent pre-rollover samples appeared
   newer than the current time and were excluded until the entire window had
   elapsed.

### Changes and rationale

- Select flow percentiles in calibrated-weight order. Positive calibration
  retains ascending raw order; negative calibration mirrors the selected raw
  index.
- Return zero flow for a zero or near-zero calibration factor rather than
  divide by it.
- Keep HX711 reads and tare-time ring resets on the Core 0 sampling task. The
  filter is re-seeded at the new tare point so readers do not observe an empty
  buffer or a false full-scale jump.
- Calibrate from the settled raw-filter snapshot and preserve raw history,
  which remains valid because it is stored in ADC units.
- Reject calibration when settling times out, no samples are available, the
  ADC delta is below the existing hardware threshold, or the calculated factor
  is invalid.
- Propagate tare and calibration failure to the UI operation wrapper. Failed
  operations keep the prior value, log the reason, and do not invoke the
  success transition.
- Disarm a timed-out blocking tare request.
- Replace absolute timestamp ordering with unsigned elapsed-time comparisons
  in flow, delta, min/max, sample-window, and SPS calculations.

### Verification

- A host regression verifies that both negative and positive calibration
  factors select 3.00 g/s from the representative flow-rate set and checks
  percentile index boundaries.
- A host regression verifies elapsed-time windows immediately across a
  `uint32_t` timestamp rollover.
- The Stage 1 exhaustive pulse-timing regression still passes.
- Final production build 39 passed: RAM 67,752 bytes; flash 2,189,671
  bytes.
- Final debug build 40 passed: RAM 67,752 bytes; flash 2,278,839 bytes.
- Final mock build 41 passed: RAM 67,808 bytes; flash 2,276,871 bytes.
- BLE host tests passed: 2 of 2.
- Python tool compilation and Git whitespace validation passed.
- Stage cost versus Stage 1: no additional RAM. The production flash increase
  is 2,512 bytes.

## Stage 3: Review follow-ups

A correctness review of stages 1 and 2 confirmed their fixes but found defects in and
around them.

### Findings

1. Cancelling auto-tune only set a deferred flag. `AutoTuneController::update()` is reached
   solely from `UIState::AUTOTUNING`, and the UI leaves that state on the same call stack, so
   the flag was never serviced. The controller stayed `is_running` and its log file stayed
   open, and every later `start()` was rejected as already running until reboot. Stage 1
   stopped the motor on cancel but left this half unfixed.
2. Polling `rmt_tx_wait_all_done()` with a zero timeout logs an ESP-IDF error on every
   unfinished poll. `libesp_driver_rmt.a` contains the `flush timeout` string,
   `CONFIG_LOG_DEFAULT_LEVEL` is `ERROR`, and nothing suppresses the `rmt` tag - roughly 27
   lines per 550 ms correction pulse at the 20 ms control interval, up to ten pulses per
   grind, and hundreds per auto-tune run.
3. The verification-failure console line still named the default latency after stage 1
   changed the behaviour to retain the previous one.
4. Stage 2 correctly stopped advancing the UI on a failed tare or calibration, but the
   overlay hides itself regardless, so the user saw it appear and vanish with the wizard on
   the same step and no explanation.
5. Encoding left a zero-duration second half in the final symbol, relying on the RMT treating
   that as an end marker - the assumption the pre-stage-1 short-pulse path avoided by writing
   a 1 us LOW.
6. The RMT payload capacity was derived from the auto-tune priming pulse while the motor test
   independently hardcoded the same 1,000 ms, and an out-of-range or failed transmission left
   `pulse_active` false, so callers read a pulse that never ran as one that had completed.
7. `tools/tests` was referenced by no build file, tool or workflow, so nothing compiled or ran
   the stage 1 and 2 regressions.
8. The blocking-tare timeout disarmed the request with a plain store, which can lose to a
   sampling-task pass already committing, and calibration inferred a settling timeout by
   comparing elapsed time against the timeout value.

### Changes and rationale

- Complete auto-tune cancellation synchronously inside `cancel()`, and remove the deferred
  flag that could never be serviced.
- Report pulse completion from the RMT transmit-done callback through an atomic flag, so the
  control loop makes no driver call and produces no driver logging.
- Report the retained latency on verification failure.
- Add a self-dismissing notice to `BlockingOperationOverlay` and an `on_failure` callback to
  the tare and calibration wrappers, used by the calibration wizard and the menu scale page.
- Spread pulse time evenly across symbols and across the halves within each symbol, so no
  half is zero-length for any pulse of at least 2 us and termination goes through the
  driver's end-of-transmission marker and the configured `eot_level`.
- Key the payload capacity off a dedicated maximum-pulse constant, assert at compile time that
  every caller fits, and return a result from `start_pulse_rmt()` so each caller can react.
- Add a `test` target to `tools/grinder.py` and a CI job that runs it on push and pull
  request.
- Claim the tare request with a compare-exchange on the sampling task, and return an explicit
  settling-timeout flag instead of inferring one from the elapsed time.

### Verification

- Host tests pass, 3 of 3, via `python3 tools/grinder.py test`. The pulse-timing regression
  additionally asserts, for every length up to 1,000,000 us, that no symbol half is
  zero-length and none exceeds the 15-bit hardware field.
- The runner was confirmed to fail and return a non-zero exit code when an assertion is
  inverted.
- Production build 50 passed: RAM 67,760 bytes; flash 2,191,127 bytes.
- Debug build passed: RAM 67,760 bytes; flash 2,281,011 bytes.
- Mock build passed: RAM 67,816 bytes; flash 2,278,739 bytes.
- Stage cost versus stage 2: 8 bytes RAM. The production flash increase is 1,456 bytes.

### Still requires hardware

- Scope the motor output for 30, 50, 100, 300, 550 and 1,000 ms pulses. The zero-duration
  dependency is gone, but the encoding remains the one part no host test can prove; the
  single-symbol lengths are the highest-value measurements.
- Cancel auto-tune during priming, then start it again immediately and confirm it runs.
- Confirm a disturbed tare and a calibration with no mass both show the failure notice and
  retain the previous zero and factor.

## Deliberately unchanged

- `-Ofast` remains enabled. No measured numerical or timing regression tied to
  it is available, so changing the global optimization mode would be
  speculative and performance-negative.
- The broader task architecture and controller interfaces remain unchanged.
- Filter constants, correction thresholds, and task rates remain unchanged.
  Without ground-truth hardware measurements, tuning them would be
  speculative and could reduce accuracy on real beans and grinders.

## On-device validation when hardware is available

- Scope the motor output for 30, 50, 100, 300, 550, and 1,000 ms pulses and
  compare HIGH time to the requested duration.
- Cancel auto-tune during its 1,000 ms priming pulse and confirm the motor
  output goes LOW immediately.
- Run mock auto-tune and manual correction flows to confirm one simulated mass
  increment per pulse.
- Complete several weighted grinds and compare final error, correction count,
  and recorded flow rate with the prior firmware.
- Tare repeatedly under both quiet and noisy conditions; verify failed/timeout
  attempts retain the previous zero and successful attempts settle near zero.
- Calibrate with the reference mass several times; verify factors are
  repeatable, polarity is preserved, and unstable/missing masses do not save.
- Leave a unit running across the `millis()` rollover (approximately 49.7
  days), or inject timestamps around rollover in a hardware test build, and
  confirm flow/SPS telemetry remains continuous.
