import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDraftWithPlan, refinePlan, updateDraft } from '../api/proprApi';
import type { DraftWithPlan, PlanTask } from '../api/proprApi';
import { usePlanRefinement } from './usePlanRefinement';

vi.mock('../api/proprApi', () => ({
  getDraftWithPlan: vi.fn(),
  refinePlan: vi.fn(),
  updateDraft: vi.fn(),
}));

const mockGetDraftWithPlan = vi.mocked(getDraftWithPlan);
const mockRefinePlan = vi.mocked(refinePlan);
const mockUpdateDraft = vi.mocked(updateDraft);

const initialPlan: PlanTask[] = [{
  id: 'task-1',
  title: 'Original task',
  body: 'Original body',
  implementation: 'Original implementation',
}];

const refinedPlan: PlanTask[] = [{
  ...initialPlan[0],
  title: 'Refined task',
}];

function makeDraft(overrides: Partial<DraftWithPlan>): DraftWithPlan {
  return {
    draft_id: 'draft-1',
    repository: 'integry/propr',
    initial_prompt: 'Test plan',
    status: 'refining',
    attachments: [],
    created_at: '2026-08-01T10:00:00.000Z',
    plan_json: initialPlan,
    ...overrides,
  };
}

async function startRefinement(
  handleRefine: (instruction: string, signal?: AbortSignal) => Promise<{ success: boolean; message: string; cancelled?: boolean }>,
  signal?: AbortSignal,
) {
  let refinement!: ReturnType<typeof handleRefine>;
  act(() => {
    refinement = handleRefine('Improve the plan', signal);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return { refinement };
}

describe('usePlanRefinement', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T12:00:00.000Z'));
    mockRefinePlan.mockResolvedValue({ plan: initialPlan, message: 'Started' });
    mockUpdateDraft.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps polling past the former five-minute attempt limit', async () => {
    let pollCount = 0;
    mockGetDraftWithPlan.mockImplementation(async () => {
      pollCount += 1;
      if (pollCount <= 300) return makeDraft({ status: 'refining' });
      return makeDraft({
        status: 'review',
        plan_json: refinedPlan,
        refinement_result: { status: 'completed', action: 'modified', summary: 'Plan improved.' },
      });
    });

    const { result } = renderHook(() => usePlanRefinement('draft-1', initialPlan));
    const { refinement } = await startRefinement(result.current.handleRefine);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(301_000);
    });
    const outcome = await refinement;

    expect(pollCount).toBe(301);
    expect(outcome).toEqual({ success: true, message: 'Plan improved.', action: 'modified' });
    expect(result.current.plan).toEqual(refinedPlan);
    expect(result.current.refinementProgress.isRefining).toBe(false);
  });

  it('surfaces a persisted refinement failure and clears progress', async () => {
    mockGetDraftWithPlan.mockResolvedValue(makeDraft({
      status: 'review',
      refinement_result: { status: 'failed', error: 'Refinement worker stopped.' },
    }));

    const { result } = renderHook(() => usePlanRefinement('draft-1', initialPlan));
    const { refinement } = await startRefinement(result.current.handleRefine);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    const outcome = await refinement;

    expect(outcome).toEqual({ success: false, message: 'Refinement worker stopped.' });
    expect(result.current.refinementProgress.isRefining).toBe(false);
  });

  it('clears progress when local polling is cancelled', async () => {
    mockGetDraftWithPlan.mockResolvedValue(makeDraft({ status: 'refining' }));
    const controller = new AbortController();
    const { result } = renderHook(() => usePlanRefinement('draft-1', initialPlan));
    const { refinement } = await startRefinement(result.current.handleRefine, controller.signal);

    controller.abort();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    const outcome = await refinement;

    expect(outcome.cancelled).toBe(true);
    expect(result.current.refinementProgress.isRefining).toBe(false);
  });

  it('clears progress when the server reports cancellation', async () => {
    mockGetDraftWithPlan.mockResolvedValue(makeDraft({
      status: 'review',
      refinement_result: { action: 'cancelled', summary: 'Stopped.' },
    }));

    const { result } = renderHook(() => usePlanRefinement('draft-1', initialPlan));
    const { refinement } = await startRefinement(result.current.handleRefine);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    const outcome = await refinement;

    expect(outcome).toEqual({ success: false, message: 'Stopped.', cancelled: true });
    expect(result.current.refinementProgress.isRefining).toBe(false);
  });

  it('stops polling at the client safety ceiling', async () => {
    mockGetDraftWithPlan.mockResolvedValue(makeDraft({ status: 'refining' }));

    const { result } = renderHook(() => usePlanRefinement('draft-1', initialPlan));
    const { refinement } = await startRefinement(result.current.handleRefine);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40 * 60 * 1000);
    });
    const outcome = await refinement;

    expect(outcome).toEqual({
      success: false,
      message: 'Refinement did not finish in time. Refresh the plan before trying again.',
    });
    expect(result.current.refinementProgress.isRefining).toBe(false);
  });
});
