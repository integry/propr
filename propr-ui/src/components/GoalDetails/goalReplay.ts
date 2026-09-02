import { GOAL_DETAIL_REFRESH_EVENT_TYPES } from '@propr/shared';
import { getGoalEvents, GoalContractError, type GoalEvent } from '../../api/goalsApi';
import { mergeGoalEvents } from './goalDetailUtils';

const PAGE_SIZE = 200;
const MAX_REPLAY_PAGES = 1_000;
const MAX_NO_PROGRESS_PAGES = 3;

export interface GoalReplayResult {
  events: GoalEvent[];
  cursor: string | null;
  sequence: number;
  detailChanged: boolean;
}

export const goalEventChangesDetail = (event: GoalEvent): boolean =>
  GOAL_DETAIL_REFRESH_EVENT_TYPES.includes(event.eventType);

const pageEventsAfter = (goalId: string, sequence: number, events: GoalEvent[]): Omit<GoalReplayResult, 'cursor'> => {
  let expected = sequence + 1;
  const replayed: GoalEvent[] = [];
  const seen = new Set<number>();
  for (const event of events) {
    if (event.goalId !== goalId) throw new GoalContractError('response.events[].goalId', `the requested goal ${goalId}`);
    if (event.sequence <= sequence || seen.has(event.sequence)) continue;
    if (event.sequence !== expected) throw new GoalContractError('response.events[].sequence', `contiguous sequence ${expected}`);
    replayed.push(event); seen.add(event.sequence); expected += 1;
  }
  return { events: replayed, sequence: expected - 1, detailChanged: replayed.some(goalEventChangesDetail) };
};

/** Drain exclusive opaque forward cursors until the requested sequence is present. */
export async function drainGoalEventGap(
  goalId: string,
  afterCursor: string | null,
  afterSequence: number,
  targetSequence: number | null,
  signal: AbortSignal
): Promise<GoalReplayResult> {
  let cursor = afterCursor;
  let sequence = afterSequence;
  let noProgress = 0;
  let replayed: GoalEvent[] = [];
  let detailChanged = false;
  const seenCursors = new Set<string>();

  let complete = false;
  for (let pageNumber = 0; !complete && pageNumber < MAX_REPLAY_PAGES; pageNumber += 1) {
    const page = await getGoalEvents(goalId, { ...(cursor ? { afterCursor: cursor } : {}), limit: PAGE_SIZE, signal });
    const canonicalPage = pageEventsAfter(goalId, sequence, page.events);
    detailChanged ||= canonicalPage.detailChanged;
    replayed = mergeGoalEvents(replayed, canonicalPage.events, goalId);
    const nextCursor = page.nextCursor;
    const madeSequenceProgress = canonicalPage.sequence > sequence;
    sequence = canonicalPage.sequence;

    if (nextCursor === null) {
      cursor = canonicalPage.events.at(-1)?.cursor ?? cursor;
      if (targetSequence === null || sequence >= targetSequence) { complete = true; continue; }
      throw new GoalContractError('response.nextCursor', `an opaque cursor reaching sequence ${targetSequence}`);
    }
    if (nextCursor === cursor || seenCursors.has(nextCursor)) {
      noProgress += 1;
      if (noProgress >= MAX_NO_PROGRESS_PAGES) throw new GoalContractError('response.nextCursor', `forward progress after ${MAX_NO_PROGRESS_PAGES} replay pages`);
      continue;
    }
    if (!madeSequenceProgress && page.events.length > 0) throw new GoalContractError('response.events', 'events advancing the opaque replay cursor');
    noProgress = 0;
    seenCursors.add(nextCursor);
    cursor = nextCursor;
    complete = targetSequence === null ? false : sequence >= targetSequence;
  }

  if (!complete || (targetSequence !== null && sequence < targetSequence)) {
    throw new GoalContractError('response.nextCursor', `sequence ${targetSequence} within ${MAX_REPLAY_PAGES} replay pages`);
  }
  return { events: replayed, cursor, sequence, detailChanged };
}
