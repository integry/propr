/** Keys typed into a field belong to the field, not to the page's shortcuts. */
export const isTypingTarget = (target: EventTarget | null): boolean =>
  target instanceof Element && Boolean(target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'));

/** While a dialog (the prompt, the log files, a follow-up) is open, every key belongs to it. */
export const isDialogOpen = (): boolean =>
  Boolean(document.querySelector('[role="dialog"], [aria-modal="true"]'));
