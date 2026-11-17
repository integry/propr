import { createContext, useCallback, useContext, useEffect, useId, useState } from 'react';

type Report = (key: string, pending: boolean) => void;
const PendingEntryContext = createContext<Report | null>(null);

/** Provided by a form so that typed entries not yet added (with their own Add button) count as its typed content. */
export const PendingEntryProvider = PendingEntryContext.Provider;

/** The entry fields of a form that hold typed text not yet added; `pending` is whether any does. */
export function usePendingEntries(): { pending: boolean; report: Report } {
  const [keys, setKeys] = useState<ReadonlySet<string>>(() => new Set());
  const report = useCallback<Report>((key, pending) => setKeys(current => {
    if (current.has(key) === pending) return current;
    const next = new Set(current);
    if (pending) next.add(key); else next.delete(key);
    return next;
  }), []);
  return { pending: keys.size > 0, report };
}

/** Reports a field's typed text to the enclosing form while it is not empty, and stops when the field goes away with it. */
export function usePendingEntry(value: string) {
  const report = useContext(PendingEntryContext);
  const key = useId();
  const pending = value.trim() !== '';
  useEffect(() => { report?.(key, pending); }, [report, key, pending]);
  useEffect(() => () => report?.(key, false), [report, key]);
}
