/**
 * Native window chrome an app dialog must leave usable: on Linux, the desktop
 * window controls and application menu the renderer draws in the titlebar.
 */
export const WINDOW_CHROME_SELECTOR = '[data-window-chrome]';

/**
 * Makes everything outside `dialog` inert except native window chrome, so the
 * workspace behind a modal dialog cannot be reached while the window itself
 * can still be minimized, maximized, closed or given its application menu.
 *
 * Ancestors of the dialog or of the chrome stay live; their other children are
 * made inert instead. Returns a function that restores the previous state.
 */
export function inertOutside(dialog: Element): () => void {
  const keep = [dialog, ...Array.from(dialog.ownerDocument.querySelectorAll(WINDOW_CHROME_SELECTOR))];
  const changed: HTMLElement[] = [];
  const visit = (parent: Element) => {
    for (const child of Array.from(parent.children)) {
      if (keep.includes(child)) continue;
      if (keep.some(element => child.contains(element))) visit(child);
      else if (child instanceof HTMLElement && !child.inert) {
        changed.push(child);
        child.inert = true;
      }
    }
  };
  visit(dialog.ownerDocument.body);
  return () => changed.forEach(element => { element.inert = false; });
}
