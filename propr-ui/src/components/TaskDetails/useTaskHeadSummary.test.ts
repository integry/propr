import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { HistoryItem } from './types';

const getTaskHistory = vi.fn();
vi.mock('../../api/proprApi', () => ({ getTaskHistory: (taskId: string) => getTaskHistory(taskId) }));

const { reconcileTokenUsage, rememberTaskHead, useTaskHeadSummary } = await import('./useTaskHeadSummary');

const entry = (state: string, minute: number, inputTokens?: number): HistoryItem => ({
  state,
  timestamp: `2026-10-04T08:${String(minute).padStart(2, '0')}:00.000Z`,
  ...(inputTokens ? { metadata: { tokenUsage: { input_tokens: inputTokens, output_tokens: 1 } } } : {}),
});

const seenAt = (minute: number, inputTokens: number) => ({
  usage: { input_tokens: inputTokens, output_tokens: 1 },
  asOf: Date.parse(entry('processing', minute).timestamp!),
});

afterEach(() => {
  vi.useRealTimers();
  getTaskHistory.mockReset();
});

describe('reconcileTokenUsage', () => {
  it('keeps the count seen live until the history records a newer one', () => {
    const history = [entry('queued', 0), entry('processing', 1, 50), entry('claude_execution', 2)];
    expect(reconcileTokenUsage(seenAt(2, 400), history)?.input_tokens).toBe(400);
    expect(reconcileTokenUsage(seenAt(2, 400), [...history, entry('completed', 5, 900)])?.input_tokens).toBe(900);
    expect(reconcileTokenUsage(undefined, history)?.input_tokens).toBe(50);
  });
});

describe('useTaskHeadSummary', () => {
  it('advances the newest run\'s consumption while an earlier run is open, through to completion', async () => {
    vi.useFakeTimers();
    const live = [entry('queued', 0), entry('claude_execution', 1)];
    // The newest run was on screen with a live count of 400 before an earlier run was opened.
    rememberTaskHead('head-run', {
      history: live, taskInfo: null, usageMetricRecords: [],
      tokenUsage: { input_tokens: 400, output_tokens: 1 },
    });
    getTaskHistory.mockResolvedValueOnce({ history: live });
    const { result } = renderHook(() => useTaskHeadSummary('head-run'));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current?.tokenUsage?.input_tokens).toBe(400);

    getTaskHistory.mockResolvedValueOnce({ history: [...live, entry('post_processing', 4, 700)] });
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(result.current?.tokenUsage?.input_tokens).toBe(700);

    getTaskHistory.mockResolvedValueOnce({ history: [...live, entry('post_processing', 4, 700), entry('completed', 6, 950)] });
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(result.current?.tokenUsage?.input_tokens).toBe(950);
    expect(result.current?.history.at(-1)?.state).toBe('completed');
  });

  it('reads a finished newest run again when the list shows it started again under the same id', async () => {
    vi.useFakeTimers();
    const done = [entry('queued', 0), entry('processing', 1), entry('completed', 2)];
    getTaskHistory.mockResolvedValue({ history: done });
    const { result, rerender } = renderHook(({ listState }) => useTaskHeadSummary('restarted-run', listState), {
      initialProps: { listState: 'completed' },
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current?.history.at(-1)?.state).toBe('completed');
    // Finished, so it is no longer polled.
    const reads = getTaskHistory.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(getTaskHistory).toHaveBeenCalledTimes(reads);

    // A follow-up starts the same run id again, and the list's refresh says so.
    const restarted = [...done, entry('queued', 5), entry('processing', 6)];
    getTaskHistory.mockResolvedValue({ history: restarted });
    rerender({ listState: 'processing' });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current?.history.at(-1)?.state).toBe('processing');
    // Working again, so it is polled again until it finishes.
    getTaskHistory.mockResolvedValue({ history: [...restarted, entry('completed', 9)] });
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(result.current?.history.at(-1)?.state).toBe('completed');
  });
});
