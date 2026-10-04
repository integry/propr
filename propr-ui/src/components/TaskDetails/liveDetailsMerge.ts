import type { LiveOutputPosition } from '@propr/shared';
import type { LiveDetails, LiveEvent } from './types';

/** Raw terminal events kept in a live view; readable (`thought`) events are always kept. */
export const MAX_LIVE_RAW_EVENTS = 500;

/** Shown wherever a view may lack output the server discarded (see `LiveDetails.historyTruncated`). */
export const HISTORY_TRUNCATED_NOTICE = 'Earlier output from this run exceeded the live log size limit and was discarded.';

/** Keeps every readable event and only the most recent raw ones. */
export const capLiveEvents = (events: LiveEvent[], maxRawEvents = MAX_LIVE_RAW_EVENTS): { events: LiveEvent[]; dropped: number } => {
  let raw = 0;
  for (const event of events) if (event.type !== 'thought') raw += 1;
  let skip = Math.max(0, raw - maxRawEvents);
  const dropped = skip;
  if (skip === 0) return { events, dropped };
  return {
    events: events.filter(event => {
      if (event.type === 'thought' || skip === 0) return true;
      skip -= 1;
      return false;
    }),
    dropped,
  };
};

/** Execution identity is encoded in the first four segments of server event IDs. */
const executionIdentity = (events: LiveEvent[]): string | null => {
  const identities = new Set(events.flatMap(event =>
    event.id?.match(/^live:[^:]+:(?:redis|conversation|stored|database):[^:]+:/)?.[0] ?? []));
  return identities.size === 1 ? [...identities][0] : null;
};

/**
 * Epochs are `<generation>:<execution counter>`, and within one generation of
 * the log the counter only grows (see core's liveOutputLog), so a lower counter
 * is an execution a later one replaced. Generations (the log was recreated after
 * expiring) carry no ordering evidence.
 */
const executionPrecedes = (epoch: string, later: string): boolean => {
  const [earlier, current] = [epoch, later].map(value => value.match(/^(?:(.*):)?(\d+)$/));
  return Boolean(earlier && current && (earlier[1] ?? '') === (current[1] ?? '') && Number(earlier[2]) < Number(current[2]));
};

/**
 * A read's position proves its shared events and metadata are newer than an
 * update at or before it, and that an earlier execution is obsolete. It does
 * not prove inclusion of history that retention may have removed.
 * Without comparable positions there is no ordering evidence.
 */
export const readCoversUpdate = (read: Pick<LiveDetails, 'liveOutputPosition'>, update: { liveOutputPosition?: LiveOutputPosition }): boolean => {
  const at = read.liveOutputPosition;
  const of = update.liveOutputPosition;
  if (!at || !of) return false;
  return at.epoch === of.epoch ? of.offset <= at.offset : executionPrecedes(of.epoch, at.epoch);
};

/**
 * The execution a state was showing when a read started, if the read found a
 * different one. Epochs never recur, and the read happened after that state was
 * known, so the read's execution replaced it: none of its updates may be applied again.
 */
export const executionSupersededByRead = (
  atRequest: Pick<LiveDetails, 'liveOutputPosition'> | undefined,
  read: Pick<LiveDetails, 'liveOutputPosition'>,
): string | null => {
  const superseded = atRequest?.liveOutputPosition?.epoch;
  const current = read.liveOutputPosition?.epoch;
  return superseded && current && superseded !== current ? superseded : null;
};

export const isSupersededUpdate = (superseded: ReadonlySet<string>, update: { liveOutputPosition?: LiveOutputPosition }): boolean =>
  Boolean(update.liveOutputPosition && superseded.has(update.liveOutputPosition.epoch));

export const isFinishedTask =(state: string | undefined): boolean =>
  ['completed', 'failed', 'cancelled'].includes(state?.toLowerCase() ?? '');

/** Full state sets shared-event order while retaining history collected in this execution. */
export const mergeFullLiveDetails = (previous: LiveDetails, full: LiveDetails, isLive = true): LiveDetails => {
  const fullEvents = full.events || [];
  const fullIds = new Set(fullEvents.flatMap(event => event.id ? [event.id] : []));
  const previousIdentity = executionIdentity(previous.events);
  const fullIdentity = executionIdentity(fullEvents);
  const sameExecution = previous.liveOutputPosition && full.liveOutputPosition
    ? previous.liveOutputPosition.epoch === full.liveOutputPosition.epoch
    : previousIdentity && fullIdentity
    ? previousIdentity === fullIdentity
    : previous.events.some(event => event.id && fullIds.has(event.id));
  const { events, retainedOmittedRaw } = sameExecution
    ? mergeExecutionEvents(previous.events, fullEvents, fullIds, isLive)
    : { events: fullEvents, retainedOmittedRaw: 0 };
  const capped = isLive ? capLiveEvents(events) : { events, dropped: 0 };
  return {
    events: capped.events,
    todos: full.todos || [],
    currentTask: full.currentTask || null,
    tokenUsage: full.tokenUsage || null,
    omittedEventCount: Math.max(0, (full.omittedEventCount ?? 0) - retainedOmittedRaw) + capped.dropped,
    // Whether history was retained from before the discard cannot be proven, so the latest full state decides.
    ...(full.historyTruncated ? { historyTruncated: true } : {}),
    // The state now reflects this read, so later updates are ordered against it.
    ...(full.liveOutputPosition ? { liveOutputPosition: full.liveOutputPosition } : {}),
  };
};

function mergeExecutionEvents(previousEvents: LiveEvent[], fullEvents: LiveEvent[], fullIds: Set<string>, isLive: boolean) {
  const events: LiveEvent[] = [];
  const isNewer = newerThanRedisSnapshot(fullEvents);
  let retainedOmittedRaw = 0;
  const retainHistory = (event: LiveEvent) => {
    if (event.type === 'thought') return true;
    if (isLive) return false;
    retainedOmittedRaw += 1;
    return true;
  };
  // Place missing history before its next shared event. This preserves prefixes
  // lost to Redis trimming as well as increments received after the snapshot.
  const before = new Map<string, LiveEvent[]>();
  let missing: LiveEvent[] = [];
  let lastSharedId: string | undefined;
  for (const event of previousEvents) {
    if (event.id && fullIds.has(event.id)) {
      // Raw history before a shared event is already covered by the full
      // snapshot's window and omission count. Live views retain only readable history.
      lastSharedId = event.id;
      before.set(event.id, missing.filter(retainHistory));
      missing = [];
    } else missing.push(event);
  }
  if (before.size === 0) {
    for (const event of missing) if (!isNewer(event) && retainHistory(event)) events.push(event);
    for (const event of fullEvents) events.push(event);
    for (const event of missing) if (isNewer(event)) events.push(event);
  } else {
    for (const event of fullEvents) {
      for (const earlier of event.id ? before.get(event.id) ?? [] : []) events.push(earlier);
      events.push(event);
    }
    // A suffix is demonstrably newer only when it follows the snapshot's end.
    const followsSnapshot = lastSharedId === fullEvents.at(-1)?.id;
    for (const event of missing) if (followsSnapshot || isNewer(event) || retainHistory(event)) events.push(event);
  }
  return { events, retainedOmittedRaw };
}

/** Redis record IDs provide ordering evidence even when retained windows no longer overlap. */
function newerThanRedisSnapshot(events: LiveEvent[]): (event: LiveEvent) => boolean {
  const position = (event: LiveEvent): [number, number] | null => {
    const match = event.id?.match(/^live:[^:]+:redis:[^:]+:(\d+):(\d+)$/);
    return match ? [Number(match[1]), Number(match[2])] : null;
  };
  const after = (a: [number, number], b: [number, number]) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
  let last: [number, number] | null = null;
  for (const event of events) {
    const at = position(event);
    if (at && (!last || after(at, last))) last = at;
  }
  return event => {
    const at = position(event);
    return at !== null && last !== null && after(at, last);
  };
}
