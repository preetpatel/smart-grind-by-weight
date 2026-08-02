#pragma once

//==============================================================================
// UI DESIGN TOKENS  (direction "B12 · Informed")
//==============================================================================
// The vocabulary the redesigned screens are built from. Deliberately separate
// from theme.h: screens are ported one at a time, and the un-ported ones keep
// the old palette until their turn comes. When the port is finished theme.h
// collapses into this file.
//
// PHYSICAL CONTEXT - the constraint everything here answers to:
// the panel is a 1.64" AMOLED, 280 x 456 px, which is 21.8 x 35.5 mm of glass
// at ~326 PPI. One millimetre is 12.85 px. That makes this a watch face, not a
// phone screen, and it sets a hard floor on type size (see below).

//------------------------------------------------------------------------------
// COLOUR
//------------------------------------------------------------------------------
// True black is free on an AMOLED - unlit pixels draw nothing - so the surface
// is #000000 rather than a dark grey, and hierarchy is carried by how much ink
// is spent rather than by layering surfaces.
#define UI_COLOR_BG 0x000000                    // Unlit. The default state of the panel
#define UI_COLOR_INK 0xF7F7F5                   // Primary text: the one thing being read
#define UI_COLOR_DIM 0x8B8B85                   // Supporting text: read second, or not at all
#define UI_COLOR_FAINT 0x57574F                 // Labels and captions: present, not competing
#define UI_COLOR_LINE 0x1C1C1A                  // Hairlines. Structure without boxes
#define UI_COLOR_SURFACE 0x121211               // The only lifted surface (sheets, overlays)

#define UI_COLOR_ACCENT 0xF0B429                // Amber. Exactly one action per screen gets it
#define UI_COLOR_ACCENT_INK 0x171206            // Text on top of the accent
#define UI_COLOR_OK 0x4FAE5F                    // Landed, verified, healthy
#define UI_COLOR_WARN 0xE0912F                  // Needs attention but not now
#define UI_COLOR_BAD 0xE0563F                   // Failed, or blocking the thing you asked for

//------------------------------------------------------------------------------
// TYPE
//------------------------------------------------------------------------------
// At 326 PPI, 24 px is 1.9 mm - the same floor watchOS sets for its smallest
// legible text. Nothing on this panel may be smaller. The concept mockups were
// evaluated on a 110 PPI monitor at 3x life size, where 10 px labels looked
// delicate; on the glass they were 0.7 mm and unreadable. Hence the floor.
// The hero faces are Montserrat instanced at Light 300 and subset to digits,
// '.' and ':'. Light because a 7 mm numeral in Medium reads as shouting; digits
// only because the rest of the face would cost ten times the flash unused.
#define UI_FONT_HERO &lv_font_hero_88           // 6.9 mm - the dose, the weight, the clock
#define UI_FONT_HERO_SMALL &lv_font_hero_60     // 4.7 mm - hero when context shares the screen
#define UI_FONT_TITLE &lv_font_montserrat_36    // 2.8 mm - screen titles
#define UI_FONT_PHRASE &lv_font_montserrat_28   // 2.2 mm - the context phrases
#define UI_FONT_BODY &lv_font_montserrat_24     // 1.9 mm - THE FLOOR. Labels, kickers, buttons
#define UI_FONT_UNIT &lv_font_montserrat_24     // The "g" riding the hero's baseline

//------------------------------------------------------------------------------
// LAYOUT
//------------------------------------------------------------------------------
#define UI_MARGIN_PX 24                         // Side margin. 1.9 mm of breathing room
#define UI_ACTION_BAR_HEIGHT_PX 92              // 7.2 mm - a comfortable thumb with wet hands
#define UI_GAP_TIGHT_PX 12
#define UI_GAP_PX 20
#define UI_GAP_LOOSE_PX 28
#define UI_HAIRLINE_PX 1

// The context block: one hairline and AT MOST two phrases, always in the same
// place at the same size. Phrases, not label/value rows - on 21.8 mm a label
// column eats half the width and the grammar breaks ("Then: restarts itself"
// reads as broken English because the eye takes the left column as a category).
// When there is nothing true to say the block disappears entirely.
#define UI_CONTEXT_MAX_PHRASES 2
#define UI_CONTEXT_PHRASE_GAP_PX 10

//------------------------------------------------------------------------------
// MOTION
//------------------------------------------------------------------------------
// Short enough that nothing waits on it. Motion here is confirmation - that a
// press registered, that the screen changed, that the selection moved - never
// decoration. Nothing animates during a grind: the control loop runs at 20 ms
// on the other core and the panel has better things to redraw.
#define UI_MOTION_INSTANT_MS 90                 // Press feedback
#define UI_MOTION_QUICK_MS 160                  // Screen changes, selection moves
#define UI_MOTION_EASE lv_anim_path_ease_out
