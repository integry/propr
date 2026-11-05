/** SQLite stores timestamps without a zone in UTC. Preserve explicit offsets. */
export function sqliteTimestampMs(value: string | Date): number {
  if (value instanceof Date) return value.getTime();
  const sqlite = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(value);
  return Date.parse(sqlite ? `${sqlite[1]}T${sqlite[2]}Z` : value);
}
