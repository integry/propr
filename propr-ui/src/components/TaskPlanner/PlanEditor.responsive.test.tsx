import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { PlanEditor } from './PlanEditor';
import type { DraftWithPlan, PlanTask } from '../../api/proprApi';

const state = vi.hoisted(() => ({
  plan: [] as PlanTask[],
}));

vi.mock('../../contexts/DemoModeContext', () => ({
  useDemoMode: () => ({ isDemoMode: false }),
}));

vi.mock('../ui/useToast', () => ({
  useToast: () => ({ addToast: vi.fn() }),
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

vi.mock('../../api/proprApi', () => ({
  finalizePlan: vi.fn(),
  updateDraft: vi.fn(),
  resetDraftToSetup: vi.fn(),
  abortRefinement: vi.fn(),
  deleteDraft: vi.fn(),
}));

vi.mock('./PlanEditorMobileLayout', () => ({
  PlanEditorMobileLayout: (props: { isChatExpanded: boolean; focusComposerRequest?: number }) => (
    <div data-testid="mobile-plan-editor">
      <output data-testid="mobile-chat-expanded">{String(props.isChatExpanded)}</output>
      <output data-testid="mobile-focus-request">{props.focusComposerRequest ?? 0}</output>
    </div>
  ),
}));

vi.mock('./PlanEditorDesktopLayout', () => ({
  PlanEditorDesktopLayout: () => <div data-testid="desktop-plan-editor" />,
}));

const task: PlanTask = {
  id: 'task-1',
  title: 'Restore mobile workflows',
  body: 'Keep every action reachable.',
  implementation: 'Use the md boundary consistently.',
};

const draft: DraftWithPlan = {
  draft_id: 'draft-1727',
  repository: 'integry/propr',
  initial_prompt: 'Restore mobile workflows',
  status: 'review',
  attachments: [],
  created_at: '2026-08-24T12:00:00.000Z',
  plan_json: [task],
  context_config: { baseBranch: 'develop' },
};

function setViewportWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: width,
  });
}

function renderEditor(width: number, notificationIntent?: 'refine') {
  setViewportWidth(width);
  return render(
    <MemoryRouter>
      <PlanEditor
        draft={draft}
        notificationIntent={notificationIntent}
        onNotificationIntentConsumed={vi.fn()}
      />
    </MemoryRouter>,
  );
}

describe('PlanEditor responsive workflow', () => {
  beforeEach(() => {
    state.plan = [task];
  });

  test.each([320, 390, 767])('uses the complete mobile review workflow at %ipx', width => {
    renderEditor(width);

    expect(screen.getByTestId('mobile-plan-editor')).toBeInTheDocument();
    expect(screen.queryByTestId('desktop-plan-editor')).not.toBeInTheDocument();
  });

  test('restores the desktop Planner Studio layout at the md boundary', () => {
    renderEditor(768);

    expect(screen.getByTestId('desktop-plan-editor')).toBeInTheDocument();
    expect(screen.queryByTestId('mobile-plan-editor')).not.toBeInTheDocument();
  });

  test('opens and focuses refinement from a notification at 390px', async () => {
    renderEditor(390, 'refine');

    await waitFor(() => {
      expect(screen.getByTestId('mobile-chat-expanded')).toHaveTextContent('true');
      expect(screen.getByTestId('mobile-focus-request')).toHaveTextContent('1');
    });
  });
});
