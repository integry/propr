import { isEqual } from 'lodash';

/**
 * The previous value when `next` holds the same data, otherwise `next`.
 *
 * A background refresh answers with a new object even when nothing changed.
 * Storing that object re-renders everything that reads it and, for long
 * selectable text (reports, transcripts, logs), can re-create its DOM and drop
 * the reader's selection, scroll position or expanded sections. Keeping the
 * previous reference when the data is structurally equal lets React bail out.
 */
export function keepIfEqual<T>(previous: T, next: T): T {
  if (previous === next) return previous;
  return isEqual(previous, next) ? previous : next;
}

