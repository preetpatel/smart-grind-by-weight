# Manufacturing Package — Verifier CNC Enclosure (rev A)

Authority: the STEP files in `step/`. This document tells the shop (and the
assembler) everything the STEP can't.

## Parts

| # | Part | Material | Stock | Finish |
|---|------|----------|-------|--------|
| 1 | Chassis | 6061-T6 aluminium | 135 × 75 × 22 mm plate | Bead blast 120–180 grit, Type II clear anodize 10–15 µm (space grey optional) |
| 2 | Top plate | Polycarbonate (Makrolon/Lexan), alt. POM-C natural | 10 mm sheet, faced to 8.0 mm | Fine bead blast top + sides (frost); leave pocket faces as machined |

Both parts are conventional 3-axis work. No undercuts anywhere.

## Chassis — setups and notes

1. **Setup 1 (from top):** face, cavity, NFC posts, devkit rails/ledges/
   end-stop, rear-wall relief pocket, outer contour. Deepest feature is the
   16 mm cavity wall; internal corners are R6.5 (Ø12 rougher, Ø8–Ø10
   finisher). The four Ø8 posts stand 17.8 mm — finish with a light spring
   pass; +0/−0.10 on height (they set the antenna gap).
2. **Setup 2 (from bottom):** Ø3.4 through-bores (continue up the post
   centres), Ø6.4 × 3.4 counterbores, Ø7.0 × 0.8 feet recesses, 1.0 mm
   bottom chamfer.
3. **Setup 3 (rear face on side or with angle head):** USB slot 24.0 × 6.5
   with full-radius ends, plus the 1.2 mm stepped cosmetic recess
   (26.4 × 8.9). Break the slot's outer edges generously — cables rub here.

Critical dimensions (else ±0.1 general, ±0.05 on fits):

| Feature | Dim | Tol |
|---|---|---|
| Post height (floor → post top) | 17.80 | +0 / −0.10 |
| Post positions (match PN7160 hole grid: 58.14 × 48.90 c-t-c) | — | ±0.05 |
| Cavity width/depth (lip fit) | 121.0 × 61.0 | +0.10 / −0 |
| Wall rim flatness (plate seats on it) | — | 0.05 |

Deburr everything; anodize after machining; mask nothing (screw bores are
clearance, anodize thickness is irrelevant there).

## Top plate — setups and notes

1. **Setup 1 (underside up):** face to 8.0, register lip (leave the lip by
   milling the surrounding field 3.0 deep), NFC pocket 5.5 deep with R2.5
   corners **plus the four Ø3.2 dogbone corner reliefs as modelled** (they
   guarantee a square-cornered PCB seats), bosses, M3 tap pilot holes
   Ø2.5 × 4.0 **flat-bottom, max depth 4.2 — do not spot deeper, 0.6 mm of
   material remains to the show face**, LED window Ø6 to depth 6.8.
2. **Setup 2 (top face up):** R2 perimeter fillet, 0.3 deep icon engrave
   (Ø1–Ø2 flat end mill; the artwork is modelled in the STEP), 0.3 seam
   chamfer.
3. **Tap M3×0.5** in the four bosses with a bottoming tap, by hand.
   Engagement is 3.5 mm in PC — torque limit 0.35 N·m. Alternative for
   repeated service: press-in brass inserts for machined plastics
   (e.g. SPIROL/Tappex M3 short series, Ø4.6 bore) — bore mod is trivial in
   `build_enclosure.py`.

Polycarbonate machining: sharp single-O-flute or polished 2-flute carbide,
air blast (no coolant needed), climb cut, keep the membrane for last and
support it — final membrane thickness 2.5 ± 0.1. Anneal at 120 °C for 30 min
before bead blasting if the shop sees stress marks (PC crazes under blast +
stress).

## Hardware BOM

| Qty | Item | Where |
|---|---|---|
| 4 | M3×22 SHCS, stainless, black-oxide preferred | base → post → PN7160 → plate boss |
| 4 | 3M Bumpon SJ5382 (Ø6.4 × 1.9, clear) | feet recesses |
| 2 | 3M VHB strips ~20 × 8 × 1 mm | devkit hold-down on the ledges |
| 1 | (optional) die-cut adhesive bottom pad, 0.8 mm PU/microfibre, 124 × 64, R8 | hides screws + feet hardware line |
| 1 | (optional) ferrite sheet 0.1–0.2 mm, NFC grade | under PN7160 antenna if range is short |

## Assembly order

1. Solder/dress the low-profile harness on the devkit (≤8 mm loom height;
   see README). Seat the devkit between the rails onto the VHB strips,
   USB ports into the rear slot, front edge against the end-stop.
2. Drop the PN7160 onto the four posts, antenna face up, connector wiring
   dressed down into the left bay.
3. Route the harness through the 3 mm channel between bays; nothing may
   stand taller than the wall rim except the four posts.
4. Place the top plate — the register lip self-locates it.
5. Flip the unit onto a soft surface. Drive 4 × M3×22 to 0.35 N·m.
6. Fit the Bumpon feet (they cover nothing — the screws sit in their own
   counterbores; fit the optional bottom pad first if using it).
7. Functional check: BLE pair, then tap a phone — expect a read at
   15–25 mm above the surface. If short, see RF notes in README.

## Why these choices (DFM rationale)

- **Two materials, one seam.** The RF constraint (no metal above or beside
  the antenna plane) is turned into the product's visual identity instead
  of being hidden.
- **Boards mount side-by-side, not stacked.** Keeps the devkit's ground
  plane and BLE antenna out from under the NFC coil, and keeps the box at
  27 mm.
- **The screw stack.** One axis fastens everything, needs no inserts in
  aluminium, no visible hardware, and service is four screws from the
  bottom.
- **Register lip instead of screws at the corners.** The interior is too
  dense at the cavity corners (NFC mounting holes sit almost exactly where
  corner bosses would go); the lip gives location and a dust labyrinth for
  free.
- **Machined posts instead of standoffs.** Post height is a machined
  dimension, so antenna-to-surface distance (4.6 mm) is controlled to
  ±0.1 without any adjustment at assembly.
