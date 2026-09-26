/**
 * Class tokens shared by every Settings view.
 *
 * Settings use one layout only: a Utility Header divides each section, and each
 * control is a single-column form group — label on top, control below, helper
 * text last — held to a readable measure instead of stretching across the
 * canvas. Import these instead of re-typing the classes so the grid stays
 * strict as sections are added.
 */

/** Utility Header text: the uppercase label that titles a settings section. */
export const SETTINGS_SECTION_TITLE = 'text-[11px] font-bold uppercase tracking-widest text-slate-500';

/** The 1px divider under a Utility Header. */
export const SETTINGS_SECTION_DIVIDER = 'border-b border-slate-200 pb-2';

/** Vertical rhythm and reading measure of a single setting row. */
export const SETTINGS_FIELD = 'mb-6 max-w-2xl';

/** Label sitting above its control. */
export const SETTINGS_LABEL = 'block text-sm font-medium text-slate-900';

/** Helper text sitting below its control. */
export const SETTINGS_HELPER = 'mt-1.5 text-[12px] leading-5 text-slate-500';

/** Text inputs, selects, and textareas: full width of the row container. */
export const SETTINGS_CONTROL = 'block w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500';

/** Checkbox sitting at the left of a toggle row, aligned to the label's cap height. */
export const SETTINGS_CHECKBOX = 'mt-0.5 h-4 w-4 flex-shrink-0 rounded border-slate-300 text-primary-600 focus:ring-primary-500 disabled:cursor-not-allowed';
