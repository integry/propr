import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDraftWithPlan, refinePlan, updateDraft } from '../api/proprApi';
import type { DraftWithPlan, PlanTask } from '../api/proprApi';
import { validatePlanItemGraph } from '@propr/shared';
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
  it('shows a restored plan without saving it again and drops a pending edit', async () => {
    const { result } = renderHook(() => usePlanRefinement('draft-1', initialPlan));

    act(() => { result.current.updateTask('task-1', { title: 'Unsaved edit' }); });
    act(() => { result.current.loadPlan(refinedPlan); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });

    expect(result.current.plan[0].title).toBe('Refined task');
    expect(mockUpdateDraft).not.toHaveBeenCalled();
    expect(result.current.canUndo).toBe(true);
  });

  it('flushes a pending edit on request', async () => {
    const { result } = renderHook(() => usePlanRefinement('draft-1', initialPlan));

    act(() => { result.current.updateTask('task-1', { title: 'Edited' }); });
    await act(async () => { await result.current.flushPendingSave(); });

    expect(mockUpdateDraft).toHaveBeenCalledTimes(1);
    expect(mockUpdateDraft.mock.calls[0][1].plan_json?.[0].title).toBe('Edited');
  });

  describe('item ids and dependsOn', () => {
    const dependentPlan: PlanTask[] = [
      { id: 'schema', title: 'Schema', body: 'Schema body', implementation: 'Schema steps' },
      { id: 'api', title: 'API', body: 'API body', implementation: 'API steps', dependsOn: ['schema'] },
      { id: 'ui', title: 'UI', body: 'UI body', implementation: 'UI steps', dependsOn: ['api', 'schema'] },
    ];
    const relation = (plan: PlanTask[]) => plan.map(task => [task.id, task.dependsOn ?? []]);

    it('keeps ids and dependsOn when tasks are reordered or edited, and saves them', async () => {
      const { result } = renderHook(() => usePlanRefinement('draft-1', dependentPlan));

      act(() => { result.current.reorderTasks('ui', 'schema'); });
      act(() => { result.current.updateTask('api', { title: 'API v2' }); });
      expect(relation(result.current.plan)).toEqual([['ui', ['api', 'schema']], ['schema', []], ['api', ['schema']]]);

      await act(async () => { await result.current.flushPendingSave(); });
      expect(relation(mockUpdateDraft.mock.calls.at(-1)![1].plan_json!)).toEqual(relation(result.current.plan));
    });

    it('drops a deleted task from dependsOn and puts it back when the task is restored', () => {
      const { result } = renderHook(() => usePlanRefinement('draft-1', dependentPlan));

      let deleted: ReturnType<typeof result.current.deleteTask> = null;
      act(() => { deleted = result.current.deleteTask('schema'); });
      expect(deleted).toMatchObject({ index: 0, dependents: ['api', 'ui'] });
      expect(relation(result.current.plan)).toEqual([['api', []], ['ui', ['api']]]);

      act(() => { result.current.restoreTask(deleted!); });
      expect(relation(result.current.plan)).toEqual([['schema', []], ['api', ['schema']], ['ui', ['api', 'schema']]]);
    });

    it('restores a dependent whose prerequisite was deleted after it, and reconnects them on the second restore', async () => {
      const { result } = renderHook(() => usePlanRefinement('draft-1', dependentPlan));
      let api: ReturnType<typeof result.current.deleteTask> = null;
      let schema: ReturnType<typeof result.current.deleteTask> = null;

      act(() => { api = result.current.deleteTask('api'); });
      act(() => { schema = result.current.deleteTask('schema'); });
      expect(relation(result.current.plan)).toEqual([['ui', []]]);

      act(() => { result.current.restoreTask(api!); });
      // The record still names the deleted schema task; the restored plan does not.
      expect(api!.task.dependsOn).toEqual(['schema']);
      expect(relation(result.current.plan)).toEqual([['ui', ['api']], ['api', []]]);
      await act(async () => { await result.current.flushPendingSave(); });
      expect(validatePlanItemGraph(mockUpdateDraft.mock.calls.at(-1)![1].plan_json!)).toEqual({ valid: true });

      act(() => { result.current.restoreTask(schema!); });
      expect(relation(result.current.plan)).toEqual([['schema', []], ['ui', ['api', 'schema']], ['api', ['schema']]]);
    });

    it('reconnects a dependent restored after its prerequisite when both were deleted, prerequisite first', () => {
      const { result } = renderHook(() => usePlanRefinement('draft-1', dependentPlan));
      let schema: ReturnType<typeof result.current.deleteTask> = null;
      let api: ReturnType<typeof result.current.deleteTask> = null;

      act(() => { schema = result.current.deleteTask('schema'); });
      act(() => { api = result.current.deleteTask('api'); });
      act(() => { result.current.restoreTask(schema!); });
      expect(relation(result.current.plan)).toEqual([['schema', []], ['ui', ['schema']]]);

      act(() => { result.current.restoreTask(api!); });
      expect(relation(result.current.plan)).toEqual([['api', ['schema']], ['schema', []], ['ui', ['schema', 'api']]]);
      expect(validatePlanItemGraph(result.current.plan)).toEqual({ valid: true });
    });
  });
});
