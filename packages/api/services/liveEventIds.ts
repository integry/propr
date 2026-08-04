/** Add a stable ID based on an event's absolute position in a parsed stream. */
export function withStableLiveEventIds<T extends object>(
  taskId: string,
  source: 'conversation' | 'redis',
  events: T[],
  totalEventCount: number,
): Array<T & { id: string }> {
  const firstAbsoluteIndex = Math.max(0, totalEventCount - events.length);
  return events.map((event, index) => (
    'id' in event && typeof event.id === 'string' && event.id.length > 0
      ? event as T & { id: string }
      : { ...event, id: `live:${taskId}:${source}:${firstAbsoluteIndex + index}` }
  ));
}
