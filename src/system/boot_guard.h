#pragma once

// Boot-loop guard: if the running image crash-resets (panic/watchdog) three
// boots in a row, switch back to the other OTA slot when it holds a valid
// app image. Turns "bad update bricks the grinder until USB" into "bad update
// auto-reverts to the previous firmware".
//
// check_on_boot() must run early in setup(), before subsystems that could be
// the source of a crash. mark_healthy_if_due() is called from loop() and
// clears the counter once the system has stayed up for 30 seconds.
namespace BootGuard {

void check_on_boot();
void mark_healthy_if_due();

// Human-readable record of the last crash rollback ("" if none), for the
// diagnostics report.
const char* last_rollback_info();

}  // namespace BootGuard
