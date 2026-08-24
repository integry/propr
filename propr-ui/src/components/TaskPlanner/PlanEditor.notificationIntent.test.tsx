import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ToastProvider } from '../ui/Toast';
import { PlanEditor } from './PlanEditor';
import type { DraftWithPlan, PlanTask } from '../../api/proprApi';

const state = vi.hoisted(() => ({
  isDemoMode: false,
  plan: [] as PlanTask[],
  finalizePlan: vi.fn(),
}));

vi.mock('../../hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../../contexts/DemoModeContext', () => ({
  useDemoMode: () => ({ isDemoMode: state.isDemoMode }),
}));
vi.mock('../../hooks/usePlanRefinement', () => ({
  usePlanRefinement: () => ({
    plan: state.plan,
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    restoreTask: vi.fn(),
    reorderTasks: vi.fn(),
    handleRefine: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    canUndo: false,
    canRedo: false,
    highlightedIds: [],
    refinementProgress: { isRefining: false },
  }),
}));
vi.mock('../../api/proprApi', async importOriginal => {
  const original = await importOriginal<typeof import('../../api/proprApi')>();
  return {
    ...original,
    finalizePlan: state.finalizePlan,
    updateDraft: vi.fn(),
    abortRefinement: vi.fn(),
    deleteDraft: vi.fn(),
    resetDraftToSetup: vi.fn(),
  };
});
vi.mock('./PlanEditorDesktopLayout', () => ({
  PlanEditorDesktopLayout: (props: { onFinalize: () => void; focusComposerRequest?: number }) => (
    <div>
      <button type="button" onClick={props.onFinalize}>Existing create issues control</button>
      <output data-testid="focus-request">{props.focusComposerRequest ?? 0}</output>
    </div>
  ),
}));
vi.mock('./PlanEditorMobileLayout', () => ({
  PlanEditorMobileLayout: () => null,
}));

const task: PlanTask = {
  id: 'task-1',
  title: 'Implement notification intents',
  body: 'Context',
  implementation: 'Implementation',
};

const draft: DraftWithPlan = {
  draft_id: 'draft-1',
  repository: 'integry/propr',
  initial_prompt: 'Add notification intents',
  status: 'review',
  attachments: [],
  created_at: '2026-08-24T12:00:00.000Z',
  plan_json: [task],
  context_config: { useEpic: true, autoMerge: false },
};

function renderEditor(intent: 'refine' | 'approve_execute', onConsumed = vi.fn()) {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <PlanEditor
          draft={draft}
          notificationIntent={intent}
          onNotificationIntentConsumed={onConsumed}
        />
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('PlanEditor notification intents', () => {
  beforeEach(() => {
    state.isDemoMode = false;
    state.plan = [task];
    state.finalizePlan.mockReset();
    state.finalizePlan.mockResolvedValue({ success: true, issuesCreated: 1 });
  });

  test('never approves from navigation and cancel leaves the plan unchanged', async () => {
    const onConsumed = vi.fn();
    renderEditor('approve_execute', onConsumed);

    expect(await screen.findByRole('dialog', { name: 'Approve this plan?' })).toBeInTheDocument();
    expect(state.finalizePlan).not.toHaveBeenCalled();
    expect(onConsumed).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(state.finalizePlan).not.toHaveBeenCalled();
  });

  test('confirmation invokes the same validated finalization path as the plan control', async () => {
    renderEditor('approve_execute');
    fireEvent.click(await screen.findByRole('button', { name: 'Approve & Create Issues' }));
    await waitFor(() => expect(state.finalizePlan).toHaveBeenCalledWith('draft-1'));
    expect(state.finalizePlan).toHaveBeenCalledTimes(1);
  });

  test('demo mode keeps the intent read-only and explains why', async () => {
    state.isDemoMode = true;
    renderEditor('approve_execute');

    expect(await screen.findByText(/Demo mode is read-only/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve & Create Issues' })).toBeDisabled();
    expect(state.finalizePlan).not.toHaveBeenCalled();
  });

  test('refine intent requests composer focus without mutating the plan', async () => {
    const onConsumed = vi.fn();
    renderEditor('refine', onConsumed);

    await waitFor(() => expect(screen.getByTestId('focus-request')).toHaveTextContent('1'));
    expect(onConsumed).toHaveBeenCalledTimes(1);
    expect(state.finalizePlan).not.toHaveBeenCalled();
  });
});
