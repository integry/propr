/** Raw terminal events kept for a live view; readable (`thought`) events are always kept. */
export const MAX_LIVE_RAW_EVENTS = 500;

/**
 * The implementation log shows every readable (`thought`) event, however long
 * the run; the raw execution log keeps only the most recent raw events.
 */
export function selectLiveEvents<T extends { type?: unknown }>(events: T[], maxRawEvents = MAX_LIVE_RAW_EVENTS): { events: T[]; omittedEventCount: number } {
  let raw = 0;
  for (const event of events) if (event.type !== 'thought') raw += 1;
  let skip = Math.max(0, raw - maxRawEvents);
  const omittedEventCount = skip;
  if (skip === 0) return { events, omittedEventCount };
  const kept = events.filter(event => {
    if (event.type === 'thought' || skip === 0) return true;
    skip -= 1;
    return false;
  });
  return { events: kept, omittedEventCount };
}
