import { useLayoutEffect, type RefObject } from 'react';

const FRAME_PROPERTIES = ['top', 'bottom', 'height'] as const;

/**
 * Keeps a `position: fixed` full-screen layer inside the area the user can see.
 *
 * An on-screen keyboard (Android Chrome, iOS Safari) shrinks and pans the visual
 * viewport while the layout viewport keeps its size, so an `inset-0` layer stays
 * partly above or below the visible area. While the visual viewport is smaller
 * than the layer, the layer is clipped to it; otherwise its stylesheet geometry
 * (including the desktop titlebar offset) applies unchanged. Pinch zoom is left
 * alone so a zoomed reader can still pan around the dialog.
 *
 * A clipped layer carries `data-visual-viewport="clipped"` so its content can
 * compact (e.g. `group-data-[visual-viewport=clipped]:`) to leave room to edit.
 * A dialog that stays mounted while closed passes `active` so the layer is
 * framed each time it renders.
 */
export function useVisualViewportFrame(ref: RefObject<HTMLElement | null>, active = true) {
  useLayoutEffect(() => {
    const viewport = window.visualViewport;
    const layer = ref.current;
    if (!active || !viewport || !layer) return;
    const reset = () => {
      for (const property of FRAME_PROPERTIES) layer.style.removeProperty(property);
      delete layer.dataset.visualViewport;
    };
    let frame = '';
    const update = () => {
      const next = Math.abs(viewport.scale - 1) > 0.01 ? null : clipToViewport(stylesheetRect(layer), viewport);
      const key = next ? `${next.top}:${next.bottom}` : '';
      if (key === frame) return;
      frame = key;
      if (!next) { reset(); return; }
      layer.style.top = `${next.top}px`;
      layer.style.bottom = 'auto';
      layer.style.height = `${Math.max(0, next.bottom - next.top)}px`;
      layer.dataset.visualViewport = 'clipped';
      // The pane just moved or shrank; keep the field being edited inside its scroll area.
      // An unchanged frame leaves the reader's own scroll position alone.
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && focused !== layer && layer.contains(focused)) revealWithin(focused, layer, next.top, next.bottom);
    };
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      reset();
    };
  }, [ref, active]);
}

/**
 * The layer's rect under its stylesheet alone, read from an empty, invisible copy so the
 * live layer is never unframed: that would let its scroll areas grow for a moment and
 * clamp the reader's position in them (e.g. a log scrolled to a match near its end).
 */
function stylesheetRect(layer: HTMLElement) {
  const probe = document.createElement('div');
  probe.className = layer.className;
  probe.setAttribute('aria-hidden', 'true');
  probe.style.visibility = 'hidden';
  probe.style.pointerEvents = 'none';
  layer.before(probe);
  const rect = probe.getBoundingClientRect();
  probe.remove();
  return rect;
}

/** The part of `base` inside the visual viewport, or null when the viewport already shows all of it. */
function clipToViewport(base: DOMRect, viewport: VisualViewport) {
  const top = Math.max(base.top, viewport.offsetTop);
  const bottom = Math.min(base.bottom, viewport.offsetTop + viewport.height);
  return top - base.top < 1 && base.bottom - bottom < 1 ? null : { top, bottom };
}

/** A scroll area that currently has something to scroll; one laid out at its content height does not. */
const scrolls = (element: HTMLElement) => /(auto|scroll)/.test(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight + 1;

/**
 * Scrolls `element`'s scroll container inside `layer` so it is shown between `top` and `bottom`. Only that
 * container moves: `scrollIntoView` would also scroll the pane's `overflow: hidden` box and
 * push the header out of view. A dialog that scrolls as a whole (a very short viewport)
 * stops short of scrolling its own heading away; a sticky heading stays put anyway.
 */
function revealWithin(element: HTMLElement, layer: HTMLElement, top: number, bottom: number) {
  let container: HTMLElement | null = element.parentElement;
  while (container && container !== layer && !scrolls(container)) container = container.parentElement;
  if (!container || container === layer) return;
  // What the container shows lies inside its borders.
  const areaTop = container.getBoundingClientRect().top + container.clientTop;
  const edge = Math.max(top, areaTop);
  const low = belowStickyHeader(container, edge);
  const high = Math.min(bottom, areaTop + container.clientHeight);
  const rect = element.getBoundingClientRect();
  if (rect.top >= low - 1 && rect.bottom <= high + 1) return;
  const before = container.scrollTop;
  const editing = element instanceof HTMLTextAreaElement && rect.height > high - low ? element : null;
  const shift = scrollToShow(rect, editing && caretLine(editing, rect), low, high);
  if (!shift) return;
  container.scrollTop += shift;
  const labelledBy = element.closest('[role="dialog"]')?.getAttribute('aria-labelledby');
  const heading = labelledBy ? document.getElementById(labelledBy) : null;
  if (!heading || !container.contains(heading)) return;
  let hidden = edge - heading.getBoundingClientRect().top;
  // Bringing the heading back must not push the line being edited, or a focused single-line
  // control such as a search field, under the keyboard (rounded down, as a scroll position
  // may be whole pixels).
  if (editing) hidden = Math.min(hidden, Math.floor(high - caretLine(editing, editing.getBoundingClientRect()).bottom));
  else if (!(element instanceof HTMLTextAreaElement)) hidden = Math.min(hidden, Math.floor(high - element.getBoundingClientRect().bottom));
  // After scrolling down to the field, the heading never pulls it back past where it started;
  // after scrolling up to it (the reader had scrolled on past the field), that start lies below.
  if (hidden > 0) container.scrollTop = shift > 0 ? Math.max(before, container.scrollTop - hidden) : container.scrollTop - hidden;
}

/** The top of what shows in `container` from `edge` down: a header sticking to its top covers what scrolls under it. */
function belowStickyHeader(container: HTMLElement, edge: number) {
  let low = edge;
  for (const child of Array.from(container.children)) {
    if (child instanceof HTMLElement && getComputedStyle(child).position === 'sticky') low = Math.max(low, child.getBoundingClientRect().bottom);
  }
  return low;
}

/**
 * How far to scroll so a field at `rect` shows between `low` and `high`. A text area taller
 * than that space (`line` is its caret's line) keeps the line being edited in view: it stays
 * put while that line shows, and otherwise shows the field's start if that includes the line,
 * or else moves just far enough to bring the line in. Any other field shows whole.
 */
function scrollToShow(rect: DOMRect, line: { top: number; bottom: number } | null, low: number, high: number) {
  if (!line) return rect.top < low || rect.height > high - low ? rect.top - low : rect.bottom - high;
  if (line.top >= low - 1 && line.bottom <= high + 1) return 0;
  if (line.bottom - (rect.top - low) <= high + 1) return rect.top - low;
  // A scroll position may be rounded to whole pixels; round away from the line so none of it is cut.
  return line.top < low ? Math.floor(line.top - low) : Math.ceil(line.bottom - high);
}

const MIRRORED = ['boxSizing', 'width', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'paddingTop', 'paddingRight',
  'paddingBottom', 'paddingLeft', 'fontFamily', 'fontSize', 'fontStyle', 'fontWeight', 'fontVariant', 'fontStretch', 'letterSpacing', 'wordSpacing',
  'lineHeight', 'textIndent', 'textTransform', 'tabSize', 'overflowWrap', 'wordBreak'] as const;

/**
 * The viewport span of the line holding `field`'s caret (its selection's focus end), laid out
 * in an invisible copy of the field so soft-wrapped lines count as the field draws them.
 */
function caretLine(field: HTMLTextAreaElement, rect: DOMRect) {
  const style = getComputedStyle(field);
  const mirror = document.createElement('div');
  for (const property of MIRRORED) mirror.style[property] = style[property];
  Object.assign(mirror.style, { position: 'absolute', top: '0', left: '-9999px', visibility: 'hidden', whiteSpace: 'pre-wrap', overflow: 'hidden' });
  // The caret sits at the selection's end when typing forwards and at its start when extending backwards.
  const caret = field.selectionDirection === 'backward' ? field.selectionStart : field.selectionEnd;
  const marker = document.createElement('span');
  // The character after the caret, or a stand-in at a line break or the end, with the rest
  // of the text after it so the word holding the caret wraps as it does in the field.
  const next = /[^\n]/.test(field.value[caret] ?? '') ? field.value[caret] : '';
  marker.textContent = next || '.';
  mirror.append(field.value.slice(0, caret), marker, field.value.slice(caret + next.length));
  mirror.setAttribute('aria-hidden', 'true');
  document.body.append(mirror);
  const at = marker.getClientRects()[0] ?? marker.getBoundingClientRect();
  const offset = at.top + at.height / 2 - mirror.getBoundingClientRect().top;
  const lineHeight = parseFloat(style.lineHeight) || at.height;
  mirror.remove();
  const middle = rect.top + offset - field.scrollTop;
  return { top: middle - lineHeight / 2, bottom: middle + lineHeight / 2 };
}
