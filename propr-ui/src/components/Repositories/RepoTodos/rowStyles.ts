// Shared layout for active and completed to-do rows.
//
// A fine-pointer desktop row is one dense line: controls sit beside the note
// and edit/delete appear on hover or keyboard focus. A `touch:` row (coarse
// pointer or phone width) gives the note the row's full width on its own line
// and puts every control, always visible and 44px square, on a bar below it.

/** Keyboard focus is always visible on row controls. */
export const focusRing =
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-1';

/** A row control: compact on desktop, a 44x44 hit area around the same mark on touch. */
export const rowControl =
  `flex-shrink-0 flex items-center justify-center rounded touch:w-11 touch:h-11 touch:mt-0 ${focusRing}`;

/** Edit and delete: icon buttons that only show on desktop hover or focus, and always on touch. */
export const rowIconButton =
  `${rowControl} p-1 touch:p-0 touch:text-slate-500 transition-colors disabled:cursor-not-allowed`;

/** Hover/focus-revealed controls on desktop; plain visible controls on touch. */
export const revealOnHover =
  'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 touch:opacity-100 transition-opacity';

/** Lucide icons scale up a little inside a touch target. */
export const rowIcon = 'touch:w-4 touch:h-4';
