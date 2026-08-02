#pragma once
#include <lvgl.h>

/*
 * The icon set, drawn rather than typed.
 *
 * LVGL's built-in symbols come from a FontAwesome subset baked into the font
 * files: they carry their own weight, their own optical sizes and their own
 * era, and none of it matches a UI built from hairlines and Light numerals.
 * These are lv_line and lv_arc primitives instead, so they inherit the stroke
 * weight of everything around them and cost no flash beyond their own geometry.
 *
 * Sizes are fixed rather than parameterised. lv_line does not copy its point
 * array - it keeps the pointer - so the points have to outlive the object, and
 * static arrays per size is the honest way to guarantee that.
 */

// A right-pointing chevron for rows that lead somewhere. 8 x 14.
lv_obj_t* ui_icon_chevron(lv_obj_t* parent, uint32_t color);

// A tick, for landed grinds and finished calibrations. 20 x 20.
lv_obj_t* ui_icon_check(lv_obj_t* parent, uint32_t color);

// The Bluetooth rune. 14 x 20.
lv_obj_t* ui_icon_bluetooth(lv_obj_t* parent, uint32_t color);

// Three arcs and a dot. 22 x 18.
lv_obj_t* ui_icon_wifi(lv_obj_t* parent, uint32_t color);

// A ringed exclamation, for anything that needs attention. 22 x 22.
lv_obj_t* ui_icon_warning(lv_obj_t* parent, uint32_t color);

// Recolours any icon returned above, cheaply enough to call every frame.
void ui_icon_set_color(lv_obj_t* icon, uint32_t color);
