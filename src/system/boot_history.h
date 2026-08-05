#pragma once

#include <stdint.h>

#include "boot_history_logic.h"

// Records why the grinder last restarted, and what it was doing at the time.
//
// esp_reset_reason() answers "brownout or firmware crash?" outright, and the
// answer used to go to Serial - a port this board does not expose - so every
// unexplained reboot stayed unexplained. Two records survive a reset instead:
//
//  1. A ring of the last 8 boots in the "bootlog" NVS namespace: reset kind,
//     build, and the wall-clock time the boot started. One write per boot,
//     plus one more once the clock syncs and that start time becomes knowable.
//  2. An RTC_NOINIT black box holding what the device was doing milliseconds
//     before it died - UI state, grind phase, cloud-sync phase, free internal
//     heap. RTC RAM survives panic, watchdog and brownout resets and costs no
//     flash, so it refreshes continuously from loop().
//
// Both surface in the diagnostics report under [BOOT HISTORY].
//
// Reading a report: a sag deep enough to drop the RTC domain presents as
// POWER_ON rather than BROWNOUT and takes the black box with it (the checksum
// rejects the debris). POWER_ON with no black box, on a grinder nobody
// unplugged, is itself the signature of a hard supply collapse.
namespace BootHistory {

// Call first in setup(), before anything that could itself crash - including
// the boot-loop guard, which may reboot into the other OTA slot.
void init();

// Called every main-loop pass: refreshes the black box and, once the clock is
// first synced, stamps this boot's start time into the ring.
void note_activity(uint8_t ui_state, uint8_t grind_phase, uint8_t sync_phase);

BootResetKind this_boot_kind();
const BootRing* ring();

// What the previous boot was doing when it stopped, or nullptr when this boot
// came up with nothing readable (fresh power-on, or the RTC domain went down).
const BootBlackBox* previous_black_box();

}  // namespace BootHistory
