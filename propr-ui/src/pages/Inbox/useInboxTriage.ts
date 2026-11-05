import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import type { Notification } from '@propr/shared';
import { isDialogOpen, isTypingTarget } from '../../components/TaskList/keyboardOwnership';
import { useOptionalToast } from '../../components/ui/useToast';
import { useInboxSelection } from '../../hooks/useInboxSelection';
import { triageTaskId } from './triageVerdict';

/** Marks the verdict pane; arrow keys pressed inside it scroll it rather than step the queue. */
export const VERDICT_PANE_ATTRIBUTE = 'data-inbox-verdict-pane';

const inVerdictPane = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest(`[${VERDICT_PANE_ATTRIBUTE}]`) !== null;

/**
 * The item to open once `removedId` leaves the queue: the next one below it,
 * or the one above when it was last; null when the queue is empty.
 */
function nextInQueue(previous: readonly Notification[], current: readonly Notification[], removedId: string): string | null {
  const remaining = new Set(current.map(notification => notification.id));
  const index = previous.findIndex(notification => notification.id === removedId);
  const after = previous.slice(index + 1).find(notification => remaining.has(notification.id));
  const before = previous.slice(0, Math.max(index, 0)).reverse().find(notification => remaining.has(notification.id));
  return (after ?? before ?? current[0])?.id ?? null;
}

const NEXT_KEYS = new Set(['j', 'ArrowDown']);
const PREVIOUS_KEYS = new Set(['k', 'ArrowUp']);
const queueStep = (key: string): number => (NEXT_KEYS.has(key) ? 1 : PREVIOUS_KEYS.has(key) ? -1 : 0);

interface QueueKeyboard {
  queue: readonly Notification[];
  selectedId: string | null;
  /** Null outside the split, where rows navigate and the keys stay the browser's. */
  select: ((id: string) => void) | null;
  /** Dismisses the open item with x, or null when it cannot be dismissed. */
  dismissSelected: (() => void) | null;
}

/**
 * j/ArrowDown and k/ArrowUp step through the activity queue and x dismisses
 * the open item. With nothing open, j and k start at the top or bottom; the
 * arrows keep scrolling the page, and scroll the verdict while focus is in it.
 * The listener reads the latest queue and selection from a ref, so it is
 * registered once rather than again on every step.
 */
function useQueueKeyboard(keyboard: QueueKeyboard) {
  const latestRef = useRef(keyboard);
  latestRef.current = keyboard;
  const enabled = keyboard.select !== null && keyboard.queue.length > 0;
  useEffect(() => {
    if (!enabled) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const { queue, selectedId, select, dismissSelected } = latestRef.current;
      if (!select) return;
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target) || isDialogOpen()) return;
      if (event.key === 'x' && dismissSelected) {
        event.preventDefault();
        dismissSelected();
        return;
      }
      const step = queueStep(event.key);
      if (!step || queue.length === 0) return;
      const index = selectedId ? queue.findIndex(notification => notification.id === selectedId) : -1;
      if (event.key.startsWith('Arrow') && (index === -1 || inVerdictPane(event.target))) return;
      const next = index === -1
        ? (step > 0 ? 0 : queue.length - 1)
        : Math.min(Math.max(index + step, 0), queue.length - 1);
      event.preventDefault();
      if (queue[next].id !== selectedId) select(queue[next].id);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [enabled]);
}

/** Most Load more reads spent looking for a selected notification the loaded pages do not hold. */
export const MAX_SELECTION_LOOKUP_READS = 8;

interface InboxTriageOptions {
  /** The activity queue, newest first; System rows are not part of it. */
  queue: readonly Notification[];
  dismiss: (id: string) => Promise<void>;
  open: (id: string) => void;
  mutationsEnabled: boolean;
  /** Every loaded notification, System rows included, to tell a loaded selection from an unloaded one. */
  notifications: readonly Notification[];
  /** The loaded pages have settled without an error. */
  loaded: boolean;
  /** Older pages remain, so a selection the loaded ones do not hold may still be on one. */
  hasMore: boolean;
  /** Reads the next page, or null while a read is in flight. */
  loadMore: (() => Promise<void>) | null;
}

export interface InboxTriage {
  /** The notification open beside the queue; always null below the split breakpoint. */
  selected: Notification | null;
  select: (id: string | null) => void;
  closePane: () => void;
  isSplitViewport: boolean;
}

/**
 * The Inbox's triage console state: which queue item is open beside the list,
 * the keys that step through and dismiss it, and the instant progression to
 * the next item once the open one leaves the queue. Only items backed by a
 * task open a verdict; the rest open their destination directly. The only read
 * it starts is Load more, while a selected notification (a reload or a shared
 * link) is on a page that has not been loaded yet.
 */
export function useInboxTriage({
  queue: activity, notifications, dismiss, open, mutationsEnabled, loaded, hasMore, loadMore,
}: InboxTriageOptions): InboxTriage {
  const queue = useMemo(() => activity.filter(notification => triageTaskId(notification) !== null), [activity]);
  const location = useLocation();
  const addToast = useOptionalToast()?.addToast;
  const selection = useInboxSelection();
  const { select, isSplitViewport } = selection;
  // A push notification's dismiss intent also names the notification; it is not a selection.
  const selectedId = new URLSearchParams(location.search).get('intent') === 'dismiss' ? null : selection.selectedId;

  // Wide screens triage beside the queue; narrower ones navigate as rows always have.
  const selected = isSplitViewport && selectedId
    ? queue.find(notification => notification.id === selectedId) ?? null
    : null;
  const closePane = useCallback(() => select(null), [select]);
  const selectedForDismiss = selected && mutationsEnabled && selected.actions.includes('dismiss') ? selected.id : null;
  const dismissSelected = useCallback(() => {
    if (selectedForDismiss) void dismiss(selectedForDismiss);
  }, [dismiss, selectedForDismiss]);
  useQueueKeyboard({
    queue,
    selectedId: selected?.id ?? null,
    select: isSplitViewport ? select : null,
    dismissSelected: selectedForDismiss ? dismissSelected : null,
  });

  // Opening a verdict reads the notification, as opening its destination does.
  // Once per selection, so a failed read that rolls back does not retry in a
  // loop; closing or changing the selection and coming back tries again.
  const readAttemptRef = useRef<string | null>(null);
  useEffect(() => {
    if (readAttemptRef.current !== selectedId) readAttemptRef.current = null;
    if (!selected || selected.readAt !== null || readAttemptRef.current === selected.id) return;
    readAttemptRef.current = selected.id;
    open(selected.id);
  }, [open, selected, selectedId]);

  // Instant queue progression: when the open item leaves the queue (dismissed,
  // a command sent, or dismissed elsewhere), the next one opens in its place.
  // If it comes back, its dismissal failed and was rolled back, so it opens
  // again unless the user has moved on. A selection the loaded queue never
  // held is looked for on the pages not loaded yet, a bounded number of reads
  // at a time, and dropped only once it is known not to be there: every page
  // is loaded (dismissed in another tab), or it is loaded but opens no
  // verdict (a System row, a plan). One the bounded reads do not reach is
  // dropped too, with a notice, rather than left in the URL opening nothing.
  const previousQueueRef = useRef(queue);
  const advancedRef = useRef<{ from: string; to: string | null } | null>(null);
  const lookupRef = useRef<{ id: string; reads: number; dropped?: boolean } | null>(null);
  useEffect(() => {
    const previous = previousQueueRef.current;
    previousQueueRef.current = queue;
    if (!isSplitViewport) return;
    const advanced = advancedRef.current;
    if (advanced && advanced.to !== selectedId) advancedRef.current = null;
    else if (advanced && queue.some(notification => notification.id === advanced.from)) {
      advancedRef.current = null;
      select(advanced.from);
      return;
    }
    if (!selectedId || queue.some(notification => notification.id === selectedId)) return;
    if (previous.some(notification => notification.id === selectedId)) {
      const next = nextInQueue(previous, queue, selectedId);
      advancedRef.current = { from: selectedId, to: next };
      select(next);
      return;
    }
    if (!loaded) return;
    if (!hasMore || notifications.some(notification => notification.id === selectedId)) {
      select(null);
      return;
    }
    if (lookupRef.current?.id !== selectedId) lookupRef.current = { id: selectedId, reads: 0 };
    if (!loadMore) return;
    if (lookupRef.current.reads >= MAX_SELECTION_LOOKUP_READS) {
      // Until the URL drops the selection this effect can run again; the notice is given once.
      if (!lookupRef.current.dropped) addToast?.({ type: 'info', message: 'That notification isn’t in the loaded Inbox. Load more to look further back.' });
      lookupRef.current.dropped = true;
      select(null);
      return;
    }
    lookupRef.current.reads += 1;
    void loadMore();
  }, [queue, notifications, isSplitViewport, select, selectedId, loaded, hasMore, loadMore, addToast]);

  return { selected, select, closePane, isSplitViewport };
}
