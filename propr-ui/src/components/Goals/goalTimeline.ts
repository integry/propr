import type { GoalInput } from '../../api/goals';
import type { LiveEvent } from '../TaskDetails/types';
import { formatRelativeTime } from '../TaskDetails/utils';

export interface GoalTimelineEvent extends LiveEvent {
  relativeTime?: string | null;
}

export interface MergeGoalTimelineOptions {
  /** When set, delivered user messages carry the same relative stamp the thinking log uses. */
  executionStartTime?: string | null;
}

const timestampMs = (value?: string | null): number | null => {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
};

const toTimelineEvent = (input: GoalInput, startMs: number | null): GoalTimelineEvent => {
  // A delivered message belongs where the provider saw it; an undelivered one only has its
  // creation time to go on.
  const timestamp = input.deliveredAt ?? input.createdAt ?? undefined;
  const eventMs = timestampMs(timestamp);
  return {
    type: 'user_input',
    id: `goal-input-${input.id}`,
    content: input.message,
    timestamp,
    inputState: input.state,
    attachmentCount: input.attachmentCount,
    relativeTime: startMs !== null && eventMs !== null ? formatRelativeTime(eventMs - startMs) : null,
  };
};

/**
 * Interleaves operator messages with the provider event stream by time.
 *
 * Provider events keep their original order — they may carry missing or unparsable timestamps —
 * and user messages are woven in around the events that do have a readable time. Messages that
 * have not reached the provider yet (or whose timestamps cannot be parsed) are appended, with
 * still-pending messages always last.
 */
export function mergeGoalTimeline(
  events: readonly GoalTimelineEvent[],
  inputs: readonly GoalInput[] | undefined,
  options: MergeGoalTimelineOptions = {},
): GoalTimelineEvent[] {
  if (!inputs?.length) return [...events];
  const startMs = timestampMs(options.executionStartTime);

  const placed: Array<{ at: number; event: GoalTimelineEvent }> = [];
  const trailing: GoalTimelineEvent[] = [];
  const pending: GoalTimelineEvent[] = [];
  inputs.forEach(input => {
    const event = toTimelineEvent(input, startMs);
    if (input.state === 'pending') return void pending.push(event);
    const at = timestampMs(input.deliveredAt) ?? timestampMs(input.createdAt);
    if (at === null) return void trailing.push(event);
    placed.push({ at, event });
  });
  placed.sort((left, right) => left.at - right.at);

  const merged: GoalTimelineEvent[] = [];
  let next = 0;
  events.forEach(event => {
    const eventMs = timestampMs(event.timestamp);
    if (eventMs !== null) {
      while (next < placed.length && placed[next].at <= eventMs) merged.push(placed[next++].event);
    }
    merged.push(event);
  });
  while (next < placed.length) merged.push(placed[next++].event);

  return [...merged, ...trailing, ...pending];
}
