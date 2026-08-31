import { getGoalEvents, GoalContractError, type GoalEvent } from '../../api/goalsApi';
import { mergeGoalEvents } from './goalDetailUtils';

const PAGE_SIZE = 200;
const MAX_REPLAY_PAGES = 1_000;
const MAX_NO_PROGRESS_PAGES = 3;

export interface GoalReplayResult {
  events: GoalEvent[];
  cursor: number;
  detailChanged: boolean;
}

export const goalEventChangesDetail = (event: GoalEvent): boolean =>
  event.type === 'lifecycle' || event.type === 'message' || event.type === 'usage';

const pageEventsAfter = (goalId: string, cursor: number, events: GoalEvent[]): GoalReplayResult => {
  let expected = cursor + 1;
  const replayed: GoalEvent[] = [];
  const seen = new Set<number>();
  for (const event of events) {
    if (event.goalId !== goalId) throw new GoalContractError('response.events[].goalId', `the requested goal ${goalId}`);
    if (event.sequence <= cursor || seen.has(event.sequence)) continue;
    if (event.sequence !== expected) throw new GoalContractError('response.events[].sequence', `contiguous sequence ${expected}`);
    replayed.push(event); seen.add(event.sequence); expected += 1;
  }
  return { events: replayed, cursor: expected - 1, detailChanged: replayed.some(goalEventChangesDetail) };
};

const pageResponseCursor = (nextCursor: number | null, eventCursor: number): number => {
  if (nextCursor !== null && nextCursor < eventCursor) {
    throw new GoalContractError('response.nextCursor', `a cursor at or after sequence ${eventCursor}`);
  }
  const responseCursor = nextCursor ?? eventCursor;
  if (responseCursor > eventCursor) throw new GoalContractError('response.nextCursor', 'a cursor that does not skip replay events');
  return responseCursor;
};

/** Drain one exclusive forward cursor until the requested sequence is present. */
export async function drainGoalEventGap(
  goalId: string,
  afterSequence: number,
  targetSequence: number | null,
  signal: AbortSignal
): Promise<GoalReplayResult> {
  let cursor = afterSequence;
  let noProgress = 0;
  let replayed: GoalEvent[] = [];
  let detailChanged = false;

  let complete = false;
  for (let pageNumber = 0; !complete && pageNumber < MAX_REPLAY_PAGES; pageNumber += 1) {
    const page = await getGoalEvents(goalId, { afterSequence: cursor, limit: PAGE_SIZE, signal });
    const canonicalPage = pageEventsAfter(goalId, cursor, page.events);
    detailChanged ||= canonicalPage.detailChanged;
    replayed = mergeGoalEvents(replayed, canonicalPage.events, goalId);
    const responseCursor = pageResponseCursor(page.nextCursor, canonicalPage.cursor);
    if (responseCursor <= cursor) {
      if (page.events.length === 0 && page.nextCursor === null && (targetSequence === null || cursor >= targetSequence)) {
        complete = true;
        continue;
      }
      noProgress += 1;
      if (noProgress >= MAX_NO_PROGRESS_PAGES) {
        throw new GoalContractError('response.nextCursor', `forward progress after ${MAX_NO_PROGRESS_PAGES} replay pages`);
      }
      continue;
    }
    noProgress = 0;
    cursor = responseCursor;
    complete = targetSequence === null ? page.nextCursor === null : cursor >= targetSequence;
  }

  if (!complete || (targetSequence !== null && cursor < targetSequence)) {
    throw new GoalContractError('response.nextCursor', `sequence ${targetSequence} within ${MAX_REPLAY_PAGES} replay pages`);
  }
  return { events: replayed, cursor, detailChanged };
}
