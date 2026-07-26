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
  instead of inferring completion from a GPIO read.
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

Pending.

## Deliberately unchanged

- `-Ofast` remains enabled. No measured numerical or timing regression tied to
  it is available, so changing the global optimization mode would be
  speculative and performance-negative.
- The broader task architecture and controller interfaces remain unchanged.

## On-device validation when hardware is available

- Scope the motor output for 30, 50, 100, 300, 550, and 1,000 ms pulses and
  compare HIGH time to the requested duration.
- Cancel auto-tune during its 1,000 ms priming pulse and confirm the motor
  output goes LOW immediately.
- Run mock auto-tune and manual correction flows to confirm one simulated mass
  increment per pulse.
- Complete several weighted grinds and compare final error, correction count,
  and recorded flow rate with the prior firmware.
