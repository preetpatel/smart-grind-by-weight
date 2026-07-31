#!/usr/bin/env python3
"""
MATTR Labs Verifier — CNC enclosure, rev A
==========================================

Two-part, two-material CNC enclosure for the verifier peripheral
(ESP32-C6 devkit + NXP PN7160 NFC board). The QR module is intentionally
out of scope for this revision.

Architecture (the "MagSafe puck" logic, applied to a box):

  * CHASSIS   — 6061-T6 aluminium unibody, machined from solid.
                Carries the ESP32-C6 devkit on integral rails and the
                PN7160 board on four integral posts that present the
                antenna just under the top surface.
  * TOP PLATE — polycarbonate (frosted) or natural POM, machined from
                10 mm stock faced to 8.0 mm. The entire top face is the
                NFC tap surface: RF-transparent, 2.5 mm membrane over
                the antenna, engraved contactless icon, and a hidden
                1.2 mm light window over the devkit's WS2812 LED that
                only appears when lit.

  One fastener axis does everything: four M3 socket screws enter from
  the underside, pass through the chassis floor and up the bore of each
  NFC post, through the PN7160 mounting holes, and thread into bosses in
  the top plate. Plate, NFC board and chassis are clamped by the same
  four hidden screws. No fastener is visible from any normal viewing
  angle; an optional full-bottom adhesive pad hides even the bottom four.

All dimensions in mm. Single source of truth — regenerate outputs with:

    pip install cadquery numpy-stl matplotlib
    python3 build_enclosure.py

Outputs: step/*.step (send these to the machine shop), stl/*.stl,
previews/*.png
"""

import math
import os

import cadquery as cq

OUT = os.path.dirname(os.path.abspath(__file__))

# ══════════════════════════════════════════════════════════════════════
# Parameters
# ══════════════════════════════════════════════════════════════════════

# ── Envelope ──────────────────────────────────────────────────────────
OUTER_W = 128.0        # X — width
OUTER_D = 68.0         # Y — depth (front = -Y, USB exits rear = +Y)
R_OUT = 10.0           # plan corner radius (outer)
WALL = 3.5             # side wall thickness
FLOOR_T = 3.0          # chassis floor thickness
CAVITY_H = 16.0        # internal cavity height (floor top → wall rim)
CHASSIS_H = FLOOR_T + CAVITY_H          # 19.0
PLATE_T = 8.0          # top plate thickness (machine from 10 mm stock)
OUTER_H = CHASSIS_H + PLATE_T           # 27.0 overall

CAV_W = OUTER_W - 2 * WALL              # 121.0
CAV_D = OUTER_D - 2 * WALL              # 61.0
R_IN = R_OUT - WALL                     # 6.5 internal corner radius

SEAM_CHAMFER = 0.3     # chamfer both sides of the split line (shadow gap)
BOTTOM_CHAMFER = 1.0   # chassis bottom outer edge
PLATE_TOP_FILLET = 2.0 # top plate upper perimeter
PLATE_SIDE_INSET = 0.10  # plate outline inset per side vs chassis

# ── Register lip (plate underside ring that keys into the cavity) ────
LIP_CLR = 0.15         # radial clearance to cavity wall, per side
LIP_W = 1.6            # lip width
LIP_H = 3.0            # lip engagement depth

# ── PN7160 NFC board ─────────────────────────────────────────────────
NFC_W = 85.13
NFC_D = 56.40
NFC_PCB_T = 1.6
NFC_UNDER_H = 8.4      # components hanging below the PCB
NFC_EDGE_CLR = 2.5     # board edge → cavity wall, left side
# Mounting holes, measured from board bottom-left corner (from the
# as-built 3D-printed enclosure in verifier-peripheral/enclosure):
NFC_HOLES = [(3.75, 3.75), (61.89, 3.75), (3.75, 52.65), (61.89, 52.65)]

NFC_X0 = -CAV_W / 2 + NFC_EDGE_CLR      # board bottom-left corner, X
NFC_Y0 = -NFC_D / 2                     # centred in depth
NFC_CX = NFC_X0 + NFC_W / 2
NFC_CY = 0.0

POST_D = 8.0           # NFC support post diameter
ANTENNA_DEPTH = 4.6    # NFC board top face below the outer top surface
BOARD_TOP_Z = OUTER_H - ANTENNA_DEPTH   # 22.4 (global Z)
POST_H = BOARD_TOP_Z - NFC_PCB_T - FLOOR_T  # 17.8 — posts stand proud of rim

# ── Top plate NFC pocket ─────────────────────────────────────────────
POCKET_CLR = 0.5       # per side around the NFC board
POCKET_DEPTH = 5.5     # into the plate underside
MEMBRANE_T = PLATE_T - POCKET_DEPTH     # 2.5 over the antenna
BOSS_D = 10.0          # plate bosses that seat on the NFC board
TAP_PILOT_D = 2.5      # M3x0.5 tap drill in PC/POM
TAP_DEPTH = 4.0        # thread depth into plate (boss + membrane)

# ── ESP32-C6 devkit ──────────────────────────────────────────────────
ESP_W = 25.47          # X (board rotated: USB on short edge faces rear)
ESP_D = 59.15          # Y
ESP_PCB_T = 1.6
ESP_LEDGE_H = 2.5      # support ledge height (clearance for solder tails)
ESP_SIDE_CLR = 0.3     # per side, rail to board edge
ESP_RIGHT_CLR = 2.5    # board right edge → cavity wall
ESP_REAR_GAP = 0.8     # board rear edge → relief pocket face

RAIL_T = 2.0           # rail wall thickness
RAIL_H = 5.5           # rail height above floor (grips PCB edge)
LEDGE_W = 1.5          # support ledge width under the board edge

ESP_X1 = CAV_W / 2 - ESP_RIGHT_CLR      # board right edge, 58.0
ESP_X0 = ESP_X1 - ESP_W                 # 32.53

# ── Rear wall: USB relief + slot ─────────────────────────────────────
RELIEF_D = 1.5         # local wall thinning behind the USB ports
RELIEF_W = 29.0        # relief pocket width
ESP_Y1 = CAV_D / 2 + RELIEF_D - ESP_REAR_GAP  # board rear edge, 31.2
ESP_Y0 = ESP_Y1 - ESP_D                 # -27.95
ESP_CX = (ESP_X0 + ESP_X1) / 2          # 45.265
ESP_CY = (ESP_Y0 + ESP_Y1) / 2

USB_SLOT_W = 24.0      # spans both USB-C ports
USB_SLOT_H = 6.5
USB_SLOT_CZ = FLOOR_T + ESP_LEDGE_H + ESP_PCB_T + 2.55  # slot centre Z, 9.65
USB_RECESS_GROW = 1.2  # cosmetic stepped recess on the outer face
USB_RECESS_DEPTH = 1.2

ENDSTOP_FACE_Y = ESP_Y0 - 0.5           # front end-stop face

# ── Bottom features ──────────────────────────────────────────────────
SCREW_CLEAR_D = 3.4    # M3 clearance through floor + posts
CBORE_D = 6.4          # M3 socket head counterbore
CBORE_DEPTH = 3.4
FOOT_D = 7.0           # recess for 3M Bumpon SJ5382 (Ø6.4 x 1.9)
FOOT_RECESS = 0.8
FOOT_POS = [(48, 29.5), (-48, 29.5), (48, -29.5), (-48, -29.5)]

# ── LED light window ─────────────────────────────────────────────────
LED_WINDOW = True
LED_POS = (ESP_CX, ESP_CY)  # over the devkit WS2812 — verify on hardware
LED_POCKET_D = 6.0
LED_MEMBRANE_T = 1.2

# ── Contactless icon engraving (top face) ────────────────────────────
ICON_CENTER = (NFC_CX, NFC_CY)   # over the antenna zone
ICON_DEPTH = 0.3
ICON_DOT_R = 1.5
ICON_RINGS = [(3.4, 5.4), (7.4, 9.4), (11.4, 13.4)]  # (r_in, r_out)
ICON_SWEEP = 110.0     # degrees of arc, opening toward +X


# ══════════════════════════════════════════════════════════════════════
# Sanity checks — the whole tolerance stack, verified on every build
# ══════════════════════════════════════════════════════════════════════

def _check():
    # NFC stack: floor → post → PCB → antenna face → membrane → outer top
    board_top = FLOOR_T + POST_H + NFC_PCB_T
    assert abs(board_top - BOARD_TOP_Z) < 1e-9
    pocket_ceiling = CHASSIS_H + POCKET_DEPTH
    boss_len = pocket_ceiling - BOARD_TOP_Z
    assert 1.5 <= boss_len <= 3.0, f"plate boss length {boss_len}"
    assert TAP_DEPTH <= boss_len + MEMBRANE_T - 0.5, "tap would break through"
    assert ANTENNA_DEPTH <= 5.0, "antenna too deep for good tap range"

    # NFC underside components clear the floor
    under_clear = (BOARD_TOP_Z - NFC_PCB_T - NFC_UNDER_H) - FLOOR_T
    assert under_clear >= 2.0, f"NFC underside clearance {under_clear}"

    # posts stand proud of the rim, inside the plate pocket
    assert POST_H + FLOOR_T > CHASSIS_H
    assert POST_H + FLOOR_T < pocket_ceiling

    # register lip clears the NFC posts
    lip_inner_x = -CAV_W / 2 + LIP_CLR + LIP_W
    post_left_edge = NFC_X0 + NFC_HOLES[0][0] - POST_D / 2
    assert post_left_edge - lip_inner_x >= 0.4, "lip hits NFC post"

    # NFC board corners sit inside the cavity corner fillets
    for cx, cy in [(-CAV_W/2 + R_IN, -CAV_D/2 + R_IN)]:
        d = math.hypot(NFC_X0 - cx, NFC_Y0 - cy)
        assert d < R_IN, "NFC board corner clipped by cavity fillet"

    # devkit rear corners reach past the cavity face into the relief
    # pocket — the relief must extend far enough into the cavity that
    # the rear-right cavity corner fillet cannot clip the PCB corner
    # (verified geometrically by the interference check in validation)
    assert ESP_Y1 > CAV_D / 2, "devkit no longer uses the relief pocket"

    # devkit (with low-profile harness, ≤8 mm above PCB) clears the plate
    esp_top = FLOOR_T + ESP_LEDGE_H + ESP_PCB_T + 8.0
    assert CHASSIS_H - esp_top >= 1.0, "devkit harness hits plate"

    # USB slot stays inside the relief wall
    assert USB_SLOT_CZ + USB_SLOT_H / 2 < CHASSIS_H
    assert USB_SLOT_CZ - USB_SLOT_H / 2 > FLOOR_T + 1.0

_check()


# ══════════════════════════════════════════════════════════════════════
# Helpers
# ══════════════════════════════════════════════════════════════════════

def rrect(w, d, r, h, z0=0.0):
    """Rounded-rectangle prism centred on origin, base at z0."""
    return (
        cq.Workplane("XY", origin=(0, 0, z0))
        .rect(w, d)
        .extrude(h)
        .edges("|Z")
        .fillet(r)
    )


def nfc_hole_positions():
    return [(NFC_X0 + hx, NFC_Y0 + hy) for hx, hy in NFC_HOLES]


# ══════════════════════════════════════════════════════════════════════
# Chassis — 6061-T6 aluminium
# ══════════════════════════════════════════════════════════════════════

def build_chassis():
    body = rrect(OUTER_W, OUTER_D, R_OUT, CHASSIS_H)

    # bottom outer edge chamfer (before any bottom-face holes exist)
    body = body.edges("<Z").chamfer(BOTTOM_CHAMFER)

    # cavity
    body = body.cut(rrect(CAV_W, CAV_D, R_IN, CAVITY_H + 1, FLOOR_T))

    # seam chamfer on the rim (outer + inner perimeter — inner doubles
    # as the lead-in for the plate's register lip)
    body = body.edges(">Z").chamfer(SEAM_CHAMFER)

    # ── NFC posts ──
    for px, py in nfc_hole_positions():
        body = body.union(
            cq.Workplane("XY", origin=(px, py, FLOOR_T))
            .circle(POST_D / 2)
            .extrude(POST_H)
        )

    # ── devkit rails, ledges, end-stop ──
    def bar(x0, x1, y0, y1, z0, z1):
        return (
            cq.Workplane("XY", origin=((x0 + x1) / 2, (y0 + y1) / 2, z0))
            .rect(x1 - x0, y1 - y0)
            .extrude(z1 - z0)
        )

    rail_y0, rail_y1 = ENDSTOP_FACE_Y, CAV_D / 2
    lft_in = ESP_X0 - ESP_SIDE_CLR          # left rail inner face
    rgt_in = ESP_X1 + ESP_SIDE_CLR          # right rail inner face
    body = body.union(bar(lft_in - RAIL_T, lft_in, rail_y0, rail_y1,
                          FLOOR_T, FLOOR_T + RAIL_H))
    body = body.union(bar(rgt_in, rgt_in + RAIL_T, rail_y0, rail_y1,
                          FLOOR_T, FLOOR_T + RAIL_H))
    # support ledges under the board edges (solder tails hang between)
    body = body.union(bar(lft_in, lft_in + LEDGE_W + ESP_SIDE_CLR,
                          rail_y0, rail_y1, FLOOR_T, FLOOR_T + ESP_LEDGE_H))
    body = body.union(bar(rgt_in - LEDGE_W - ESP_SIDE_CLR, rgt_in,
                          rail_y0, rail_y1, FLOOR_T, FLOOR_T + ESP_LEDGE_H))
    # front end-stop (takes USB insertion load)
    body = body.union(bar(lft_in - RAIL_T, rgt_in + RAIL_T,
                          -CAV_D / 2 - 0.5, ENDSTOP_FACE_Y,
                          FLOOR_T, FLOOR_T + RAIL_H))

    # ── rear wall: relief pocket (thins wall to 2.0 behind the ports).
    # The pocket reaches 2.3 into the cavity so it also clears the
    # rear-right cavity corner fillet away from the devkit PCB corner.
    relief_reach = 2.3
    relief = (
        cq.Workplane("XY", origin=(ESP_CX,
                                   CAV_D / 2 + (RELIEF_D - relief_reach) / 2,
                                   FLOOR_T))
        .rect(RELIEF_W, RELIEF_D + relief_reach)
        .extrude(CAVITY_H + 1)
        .edges("|Z and >Y").fillet(1.0)
    )
    body = body.cut(relief)

    # ── USB-C slot (through) + cosmetic stepped recess (outer face) ──
    def slot(width, height, depth, y_start):
        s = (
            cq.Workplane("XY")
            .slot2D(width, height, 0)
            .extrude(depth)
            .rotate((0, 0, 0), (1, 0, 0), -90)   # extrusion now along +Y
            .translate((ESP_CX, y_start, USB_SLOT_CZ))
        )
        return s

    body = body.cut(slot(USB_SLOT_W, USB_SLOT_H, WALL + 2, CAV_D / 2 - 1))
    body = body.cut(slot(USB_SLOT_W + 2 * USB_RECESS_GROW,
                         USB_SLOT_H + 2 * USB_RECESS_GROW,
                         USB_RECESS_DEPTH + 0.01,
                         OUTER_D / 2 - USB_RECESS_DEPTH))

    # ── bottom: screw bores through floor + posts, counterbores, feet ──
    for px, py in nfc_hole_positions():
        body = body.cut(
            cq.Workplane("XY", origin=(px, py, -0.5))
            .circle(SCREW_CLEAR_D / 2)
            .extrude(FLOOR_T + POST_H + 1)
        )
        body = body.cut(
            cq.Workplane("XY", origin=(px, py, -0.01))
            .circle(CBORE_D / 2)
            .extrude(CBORE_DEPTH)
        )
    for fx, fy in FOOT_POS:
        body = body.cut(
            cq.Workplane("XY", origin=(fx, fy, -0.01))
            .circle(FOOT_D / 2)
            .extrude(FOOT_RECESS)
        )

    return body


# ══════════════════════════════════════════════════════════════════════
# Top plate — polycarbonate (frosted) or POM natural
# ══════════════════════════════════════════════════════════════════════

def build_plate(engrave=True):
    w = OUTER_W - 2 * PLATE_SIDE_INSET
    d = OUTER_D - 2 * PLATE_SIDE_INSET
    body = rrect(w, d, R_OUT - PLATE_SIDE_INSET, PLATE_T)
    body = body.edges(">Z").fillet(PLATE_TOP_FILLET)
    body = body.edges("<Z").chamfer(SEAM_CHAMFER)

    # ── register lip ring (keys into the cavity) ──
    lip_o_w = CAV_W - 2 * LIP_CLR
    lip_o_d = CAV_D - 2 * LIP_CLR
    ring = rrect(lip_o_w, lip_o_d, R_IN - LIP_CLR, LIP_H, -LIP_H).cut(
        rrect(lip_o_w - 2 * LIP_W, lip_o_d - 2 * LIP_W,
              R_IN - LIP_CLR - LIP_W, LIP_H + 0.2, -LIP_H - 0.1)
    )
    # interrupt the ring across the rear relief / USB zone
    ring = ring.cut(
        cq.Workplane("XY", origin=(ESP_CX, CAV_D / 2 - 2, -LIP_H - 0.1))
        .rect(RELIEF_W + 4, 8)
        .extrude(LIP_H + 0.2)
    )
    body = body.union(ring)

    # ── NFC pocket (leaves the 2.5 mm tap membrane) ──
    # R2.5 corners for the cutter, plus dogbone corner reliefs so even a
    # dead-square PCB corner floats free of the fillet.
    pocket = (
        cq.Workplane("XY", origin=(NFC_CX, NFC_CY, -0.1))
        .rect(NFC_W + 2 * POCKET_CLR, NFC_D + 2 * POCKET_CLR)
        .extrude(POCKET_DEPTH + 0.1)
        .edges("|Z").fillet(2.5)
    )
    for sx in (-1, 1):
        for sy in (-1, 1):
            corner_x = NFC_CX + sx * NFC_W / 2
            corner_y = NFC_CY + sy * NFC_D / 2
            pocket = pocket.union(
                cq.Workplane("XY", origin=(corner_x + sx * 0.4,
                                           corner_y + sy * 0.4, -0.1))
                .circle(1.6)
                .extrude(POCKET_DEPTH + 0.1)
            )
    body = body.cut(pocket)

    # ── bosses that seat on the NFC board (screw bosses) ──
    boss_z0 = BOARD_TOP_Z - CHASSIS_H       # 3.4, in plate coordinates
    for px, py in nfc_hole_positions():
        body = body.union(
            cq.Workplane("XY", origin=(px, py, boss_z0))
            .circle(BOSS_D / 2)
            .extrude(POCKET_DEPTH - boss_z0)
        )
        body = body.cut(
            cq.Workplane("XY", origin=(px, py, boss_z0 - 0.01))
            .circle(TAP_PILOT_D / 2)
            .extrude(TAP_DEPTH + 0.01)
        )

    # ── hidden LED light window ──
    if LED_WINDOW:
        body = body.cut(
            cq.Workplane("XY", origin=(LED_POS[0], LED_POS[1], -0.1))
            .circle(LED_POCKET_D / 2)
            .extrude(PLATE_T - LED_MEMBRANE_T + 0.1)
        )

    # ── contactless icon engraving ──
    # (skippable: OCC's tessellator mis-meshes the engraved top face in
    # STL exports, so the viewing STL is exported un-engraved. The STEP
    # files — the manufacturing authority — always carry the engraving.)
    if engrave:
        body = body.cut(icon_solid())

    return body


def icon_solid():
    """Contactless symbol: centre dot + three arcs, cut into the top."""
    cx, cy = ICON_CENTER
    z0 = PLATE_T - ICON_DEPTH
    parts = (
        cq.Workplane("XY", origin=(cx, cy, z0))
        .circle(ICON_DOT_R)
        .extrude(ICON_DEPTH + 0.1)
    )
    for r_in, r_out in ICON_RINGS:
        ring = (
            cq.Workplane("XY", origin=(cx, cy, z0))
            .circle(r_out)
            .circle(r_in)
            .extrude(ICON_DEPTH + 0.1)
        )
        wedge = cq.Solid.makeCylinder(
            r_out + 1, ICON_DEPTH + 0.1,
            cq.Vector(cx, cy, z0), cq.Vector(0, 0, 1),
            ICON_SWEEP,
        ).rotate(cq.Vector(cx, cy, 0), cq.Vector(cx, cy, 1), -ICON_SWEEP / 2)
        parts = parts.union(ring.intersect(cq.Workplane(obj=wedge)))
    return parts


# ══════════════════════════════════════════════════════════════════════
# Board mockups (for the assembly STEP only — not machined parts)
# ══════════════════════════════════════════════════════════════════════

def nfc_mockup():
    pcb = (
        cq.Workplane("XY", origin=(NFC_CX, NFC_CY, BOARD_TOP_Z - NFC_PCB_T))
        .rect(NFC_W, NFC_D)
        .extrude(NFC_PCB_T)
    )
    comps = (
        cq.Workplane("XY", origin=(NFC_CX, NFC_CY,
                                   BOARD_TOP_Z - NFC_PCB_T - NFC_UNDER_H))
        .rect(NFC_W - 16, NFC_D - 16)
        .extrude(NFC_UNDER_H)
    )
    body = pcb.union(comps)
    for px, py in nfc_hole_positions():
        body = body.cut(
            cq.Workplane("XY", origin=(px, py, BOARD_TOP_Z - NFC_PCB_T - 0.1))
            .circle(1.6)
            .extrude(NFC_PCB_T + 0.2)
        )
    return body


def esp_mockup():
    z0 = FLOOR_T + ESP_LEDGE_H
    pcb = (
        cq.Workplane("XY", origin=(ESP_CX, ESP_CY, z0))
        .rect(ESP_W, ESP_D)
        .extrude(ESP_PCB_T)
    )
    comps = (
        cq.Workplane("XY", origin=(ESP_CX, ESP_CY, z0 + ESP_PCB_T))
        .rect(ESP_W - 4, ESP_D - 6)
        .extrude(4.0)
    )
    usb = (
        cq.Workplane("XY", origin=(ESP_CX, ESP_Y1 - 3, z0 + ESP_PCB_T))
        .rect(18, 7)
        .extrude(3.2)
    )
    return pcb.union(comps).union(usb)


# ══════════════════════════════════════════════════════════════════════
# Build + export
# ══════════════════════════════════════════════════════════════════════

def main():
    print("building chassis…")
    chassis = build_chassis()
    print("building top plate…")
    plate = build_plate()
    plate_placed = plate.translate((0, 0, CHASSIS_H))

    os.makedirs(f"{OUT}/step", exist_ok=True)
    os.makedirs(f"{OUT}/stl", exist_ok=True)

    cq.exporters.export(chassis, f"{OUT}/step/verifier-chassis.step")
    cq.exporters.export(plate, f"{OUT}/step/verifier-top-plate.step")
    cq.exporters.export(chassis, f"{OUT}/stl/verifier-chassis.stl",
                        tolerance=0.02)
    # STL is for quick viewing only; see the engrave note in build_plate()
    cq.exporters.export(build_plate(engrave=False),
                        f"{OUT}/stl/verifier-top-plate.stl", tolerance=0.02)
    cq.exporters.export(icon_solid(), f"{OUT}/stl/verifier-icon.stl",
                        tolerance=0.01)

    asm = cq.Assembly(name="verifier-enclosure")
    asm.add(chassis, name="chassis",
            color=cq.Color(0.72, 0.73, 0.75, 1.0))
    asm.add(plate_placed, name="top-plate",
            color=cq.Color(0.95, 0.95, 0.94, 0.6))
    asm.add(nfc_mockup(), name="pn7160-board",
            color=cq.Color(0.1, 0.3, 0.65, 1.0))
    asm.add(esp_mockup(), name="esp32c6-devkit",
            color=cq.Color(0.1, 0.45, 0.2, 1.0))
    asm.export(f"{OUT}/step/verifier-assembly.step")

    print("done.")
    print(f"  outer:          {OUTER_W} x {OUTER_D} x {OUTER_H} mm")
    print(f"  antenna depth:  {ANTENNA_DEPTH} mm below tap surface")
    print(f"  screws:         4x M3x22 SHCS, hidden in the base")


if __name__ == "__main__":
    main()
