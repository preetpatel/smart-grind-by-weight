#include "ui_icons.h"

#include "../config/constants.h"

namespace {

constexpr int kStrokePx = 2;

// lv_line keeps the pointer it is given, so every point array here has static
// storage duration. They are shared across every instance of an icon, which is
// safe because none of them are ever mutated.
const lv_point_precise_t kChevronPts[] = {{1, 1}, {7, 7}, {1, 13}};
const lv_point_precise_t kCheckPts[] = {{3, 10}, {8, 15}, {17, 4}};
const lv_point_precise_t kBluetoothUpper[] = {{7, 19}, {7, 1}, {13, 6}, {2, 13}};
const lv_point_precise_t kBluetoothLower[] = {{2, 6}, {13, 13}, {7, 19}};

lv_obj_t* make_holder(lv_obj_t* parent, int32_t w, int32_t h) {
    lv_obj_t* holder = lv_obj_create(parent);
    lv_obj_set_size(holder, w, h);
    lv_obj_set_style_bg_opa(holder, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(holder, 0, 0);
    lv_obj_set_style_pad_all(holder, 0, 0);
    lv_obj_set_style_radius(holder, 0, 0);
    lv_obj_clear_flag(holder, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_clear_flag(holder, LV_OBJ_FLAG_CLICKABLE);
    return holder;
}

lv_obj_t* make_line(lv_obj_t* parent, const lv_point_precise_t* pts, uint32_t count, uint32_t color) {
    lv_obj_t* line = lv_line_create(parent);
    lv_line_set_points(line, pts, count);
    lv_obj_set_style_line_width(line, kStrokePx, 0);
    lv_obj_set_style_line_color(line, lv_color_hex(color), 0);
    lv_obj_set_style_line_rounded(line, true, 0);
    lv_obj_set_pos(line, 0, 0);
    return line;
}

}  // namespace

lv_obj_t* ui_icon_chevron(lv_obj_t* parent, uint32_t color) {
    lv_obj_t* holder = make_holder(parent, 8, 14);
    make_line(holder, kChevronPts, 3, color);
    return holder;
}

lv_obj_t* ui_icon_check(lv_obj_t* parent, uint32_t color) {
    lv_obj_t* holder = make_holder(parent, 20, 20);
    make_line(holder, kCheckPts, 3, color);
    return holder;
}

lv_obj_t* ui_icon_bluetooth(lv_obj_t* parent, uint32_t color) {
    // Two strokes rather than one: the rune crosses itself, and a single
    // polyline would have to double back through the middle.
    lv_obj_t* holder = make_holder(parent, 14, 20);
    make_line(holder, kBluetoothUpper, 4, color);
    make_line(holder, kBluetoothLower, 3, color);
    return holder;
}

lv_obj_t* ui_icon_wifi(lv_obj_t* parent, uint32_t color) {
    // The holder has to be at least as wide as the outermost arc: LVGL clips
    // children to their parent, so a 32 px arc in a 22 px box loses its ends.
    lv_obj_t* holder = make_holder(parent, 34, 20);

    // Three nested arcs sharing a centre at the dot, each a 100 degree sweep
    // opening upward.
    const int32_t radii[] = {16, 10, 5};
    for (int i = 0; i < 3; i++) {
        lv_obj_t* arc = lv_arc_create(holder);
        const int32_t d = radii[i] * 2;
        lv_obj_set_size(arc, d, d);
        lv_obj_align(arc, LV_ALIGN_BOTTOM_MID, 0, radii[i]);
        lv_arc_set_bg_angles(arc, 220, 320);
        lv_arc_set_value(arc, 0);
        lv_obj_set_style_arc_width(arc, kStrokePx, LV_PART_MAIN);
        lv_obj_set_style_arc_color(arc, lv_color_hex(color), LV_PART_MAIN);
        lv_obj_set_style_arc_rounded(arc, true, LV_PART_MAIN);
        lv_obj_set_style_arc_opa(arc, LV_OPA_TRANSP, LV_PART_INDICATOR);
        lv_obj_set_style_bg_opa(arc, LV_OPA_TRANSP, 0);
        lv_obj_set_style_border_width(arc, 0, 0);
        lv_obj_set_style_pad_all(arc, 0, 0);
        lv_obj_remove_style(arc, nullptr, LV_PART_KNOB);
        lv_obj_clear_flag(arc, LV_OBJ_FLAG_CLICKABLE);
    }

    lv_obj_t* dot = lv_obj_create(holder);
    lv_obj_set_size(dot, 4, 4);
    lv_obj_align(dot, LV_ALIGN_BOTTOM_MID, 0, 0);
    lv_obj_set_style_radius(dot, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_color(dot, lv_color_hex(color), 0);
    lv_obj_set_style_bg_opa(dot, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(dot, 0, 0);
    lv_obj_clear_flag(dot, LV_OBJ_FLAG_SCROLLABLE);

    return holder;
}

lv_obj_t* ui_icon_warning(lv_obj_t* parent, uint32_t color) {
    // A ringed exclamation rather than the usual triangle: at 22 px a triangle
    // outline turns to mush, and the ring reads at any size.
    lv_obj_t* holder = make_holder(parent, 22, 22);
    lv_obj_set_style_radius(holder, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_border_width(holder, kStrokePx, 0);
    lv_obj_set_style_border_color(holder, lv_color_hex(color), 0);

    lv_obj_t* bang = lv_label_create(holder);
    lv_label_set_text(bang, "!");
    lv_obj_set_style_text_font(bang, &lv_font_montserrat_16, 0);
    lv_obj_set_style_text_color(bang, lv_color_hex(color), 0);
    lv_obj_center(bang);

    return holder;
}

void ui_icon_set_color(lv_obj_t* icon, uint32_t color) {
    if (!icon) return;

    // The status icons are recoloured on every UI frame, and every style write
    // invalidates the object whether or not the value changed. The last colour
    // is stashed on the holder so the common case costs one comparison.
    const uintptr_t tag = static_cast<uintptr_t>(color) | 0x80000000UL;
    if (reinterpret_cast<uintptr_t>(lv_obj_get_user_data(icon)) == tag) {
        return;
    }
    lv_obj_set_user_data(icon, reinterpret_cast<void*>(tag));

    const lv_color_t c = lv_color_hex(color);

    // The ring on the warning icon lives on the holder itself.
    if (lv_obj_get_style_border_width(icon, LV_PART_MAIN) > 0) {
        lv_obj_set_style_border_color(icon, c, 0);
    }

    for (uint32_t i = 0; i < lv_obj_get_child_cnt(icon); i++) {
        lv_obj_t* child = lv_obj_get_child(icon, i);
        if (!child) continue;
        lv_obj_set_style_line_color(child, c, 0);
        lv_obj_set_style_arc_color(child, c, LV_PART_MAIN);
        lv_obj_set_style_bg_color(child, c, 0);
        lv_obj_set_style_text_color(child, c, 0);
    }
}
