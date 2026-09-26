export type LiveEventSource = 'conversation' | 'redis' | 'stored' | 'database';

interface StableLiveEventIdOptions<T extends object> {
  taskId: string;
  source: LiveEventSource;
  events: T[];
  totalEventCount: number;
  executionNamespace: string;
}

function idSegment(value: unknown): string {
  return encodeURIComponent(typeof value === 'string' && value.length > 0 ? value : 'unknown');
}

/** Add a stable, execution-scoped ID based on an event's parsed stream position. */
export function withStableLiveEventIds<T extends object>(
  options: StableLiveEventIdOptions<T>,
): Array<T & { id: string }> {
  const { taskId, source, events, totalEventCount, executionNamespace } = options;
  const firstAbsoluteIndex = Math.max(0, totalEventCount - events.length);
  const prefix = `live:${idSegment(taskId)}:${source}:${idSegment(executionNamespace)}`;
  return events.map((event, index) => {
    const eventType = 'type' in event ? idSegment(event.type) : 'unknown';
    const externalId = 'id' in event && typeof event.id === 'string' && event.id.length > 0
      ? event.id
      : null;
    const id = externalId
      ? `${prefix}:${eventType}:external:${idSegment(externalId)}`
      : `${prefix}:${eventType}:sequence:${firstAbsoluteIndex + index}`;
    return { ...event, id };
  });
}
