// One literal stroke spec shared by every stroked glyph in the sidebar.
//
// lucide resolves stroke-width in 24px-viewBox units, so the same value would
// normally paint different weights at different rendered sizes (a 16px nav
// icon vs a 12px usage-widget chevron). SIDEBAR_ICON_STROKE_CLASS pairs with
// the global `vector-effect: non-scaling-stroke` rule in index.css, which
// makes the value literal CSS pixels: every sidebar icon receives the exact
// same stroke-width attribute AND paints the exact same 1.5px line.
// stroke-linecap / stroke-linejoin are lucide's uniform "round" on every icon.
export const SIDEBAR_ICON_STROKE_WIDTH = 1.5;
export const SIDEBAR_ICON_STROKE_CLASS = 'sidebar-icon-stroke';
