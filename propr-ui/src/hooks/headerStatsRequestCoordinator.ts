export type HeaderStatsResource = 'queue' | 'drafts' | 'tasks' | 'status';

interface InFlightRead {
  promise: Promise<unknown>;
}

// Header data is deliberately not cached here. This map only lets simultaneous
// consumers of the same account/instance await one request while it is in
// flight. Entries disappear as soon as the read settles.
const inFlightReads = new Map<string, InFlightRead>();

export function coalesceHeaderStatsRead<T>(
  identityKey: string,
  resource: HeaderStatsResource,
  read: () => Promise<T>,
): Promise<T> {
  const key = `${identityKey}\0${resource}`;
  const existing = inFlightReads.get(key);
  if (existing) return existing.promise as Promise<T>;

  const promise = read().finally(() => {
    if (inFlightReads.get(key)?.promise === promise) inFlightReads.delete(key);
  });
  inFlightReads.set(key, { promise });
  return promise;
}

