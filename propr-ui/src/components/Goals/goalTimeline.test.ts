import { describe, expect, it } from 'vitest';
import { mergeGoalTimeline } from './goalTimeline';
import type { GoalInput } from '../../api/goals';
import type { LiveEvent } from '../TaskDetails/types';

const event = (timestamp: string | undefined, content: string): LiveEvent => ({
  type: 'thought', content, timestamp,
});

const input = (overrides: Partial<GoalInput> & { id: string }): GoalInput => ({
  message: `message ${overrides.id}`,
  attachmentCount: 0,
  state: 'delivered',
  createdAt: '2026-09-22T10:00:00.000Z',
  deliveredAt: '2026-09-22T10:00:00.000Z',
  ...overrides,
});

const contents = (events: ReturnType<typeof mergeGoalTimeline>) => events.map(item => item.content);

describe('mergeGoalTimeline', () => {
  it('returns the provider events untouched when there are no inputs', () => {
    const events = [event('2026-09-22T10:00:00.000Z', 'first')];
    expect(mergeGoalTimeline(events, [])).toEqual(events);
    expect(mergeGoalTimeline(events, undefined)).toEqual(events);
  });

  it('interleaves delivered messages into chronological position', () => {
    const merged = mergeGoalTimeline([
      event('2026-09-22T10:00:00.000Z', 'before'),
      event('2026-09-22T10:10:00.000Z', 'after'),
    ], [
      input({ id: 'a', message: 'steer me', deliveredAt: '2026-09-22T10:05:00.000Z' }),
    ]);

    expect(contents(merged)).toEqual(['before', 'steer me', 'after']);
    expect(merged[1]).toMatchObject({
      type: 'user_input', inputState: 'delivered', timestamp: '2026-09-22T10:05:00.000Z',
    });
  });

  it('orders by deliveredAt rather than createdAt', () => {
    const merged = mergeGoalTimeline([
      event('2026-09-22T10:10:00.000Z', 'provider turn'),
    ], [
      input({ id: 'a', message: 'queued long ago', createdAt: '2026-09-22T09:00:00.000Z', deliveredAt: '2026-09-22T10:20:00.000Z' }),
    ]);

    expect(contents(merged)).toEqual(['provider turn', 'queued long ago']);
  });

  it('keeps pending messages at the end even when they are the oldest rows', () => {
    const merged = mergeGoalTimeline([
      event('2026-09-22T11:00:00.000Z', 'provider turn'),
    ], [
      input({ id: 'pending', message: 'not delivered yet', state: 'pending', createdAt: '2026-09-22T09:00:00.000Z', deliveredAt: null }),
      input({ id: 'delivered', message: 'already landed', deliveredAt: '2026-09-22T10:00:00.000Z' }),
    ]);

    expect(contents(merged)).toEqual(['already landed', 'provider turn', 'not delivered yet']);
    expect(merged[2]).toMatchObject({ type: 'user_input', inputState: 'pending' });
  });

  it('sorts multiple delivered messages against each other', () => {
    const merged = mergeGoalTimeline([
      event('2026-09-22T10:30:00.000Z', 'provider turn'),
    ], [
      input({ id: 'second', message: 'second', deliveredAt: '2026-09-22T10:20:00.000Z' }),
      input({ id: 'first', message: 'first', deliveredAt: '2026-09-22T10:10:00.000Z' }),
    ]);

    expect(contents(merged)).toEqual(['first', 'second', 'provider turn']);
  });

  it('keeps provider events with unparsable timestamps in their original position', () => {
    const merged = mergeGoalTimeline([
      event(undefined, 'no timestamp'),
      event('not-a-date', 'bad timestamp'),
      event('2026-09-22T10:30:00.000Z', 'provider turn'),
    ], [
      input({ id: 'a', message: 'steer me', deliveredAt: '2026-09-22T10:20:00.000Z' }),
    ]);

    expect(contents(merged)).toEqual(['no timestamp', 'bad timestamp', 'steer me', 'provider turn']);
  });

  it('appends messages whose timestamps cannot be parsed, before pending messages', () => {
    const merged = mergeGoalTimeline([
      event('2026-09-22T10:30:00.000Z', 'provider turn'),
    ], [
      input({ id: 'broken', message: 'unparsable', createdAt: 'nonsense', deliveredAt: 'also nonsense' }),
      input({ id: 'pending', message: 'queued', state: 'pending', deliveredAt: null }),
    ]);

    expect(contents(merged)).toEqual(['provider turn', 'unparsable', 'queued']);
  });

  it('carries attachment counts and relative stamps onto the merged event', () => {
    const merged = mergeGoalTimeline([], [
      input({ id: 'a', message: 'with files', attachmentCount: 2, deliveredAt: '2026-09-22T10:01:30.000Z' }),
    ], { executionStartTime: '2026-09-22T10:00:00.000Z' });

    expect(merged[0]).toMatchObject({
      type: 'user_input',
      id: 'goal-input-a',
      attachmentCount: 2,
      relativeTime: '1m 30s',
    });
  });

  it('keeps a long operator message verbatim on the merged event', () => {
    const long = 'x'.repeat(10_000);
    const merged = mergeGoalTimeline([], [input({ id: 'a', message: long })]);

    expect(merged[0].content).toBe(long);
  });
});
