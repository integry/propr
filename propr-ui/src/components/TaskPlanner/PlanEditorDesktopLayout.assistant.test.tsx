import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { PlanEditorPanels } from './PlanEditorDesktopLayout';

vi.mock('./setupWizardHooks', () => ({ useAgentsLoader: () => [] }));
vi.mock('../../hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('./TaskCardList', () => ({ default: () => <div>Specification</div> }));

const props = {
  plan: [],
  highlightedIds: [],
  draftId: 'draft-1',
  chatHistory: [],
  refinementProgress: null,
  onTaskChange: vi.fn(),
  onDeleteTask: vi.fn(),
  onReorderTasks: vi.fn(),
  onRefine: vi.fn(),
  onChatMessagesChange: vi.fn(),
  onStopRefinement: vi.fn(async () => {}),
} as unknown as React.ComponentProps<typeof PlanEditorPanels>;

describe('PlanEditorPanels Assistant pane', () => {
  beforeAll(() => { Element.prototype.scrollIntoView = vi.fn(); });

  test('keeps an unsent Assistant message when the pane is hidden and reopened', () => {
    const view = render(<PlanEditorPanels {...props} isAssistantOpen />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Refinement instructions' }), { target: { value: 'Split step 3 in two' } });

    view.rerender(<PlanEditorPanels {...props} isAssistantOpen={false} />);
    expect(screen.getByTestId('plan-assistant')).not.toBeVisible();

    view.rerender(<PlanEditorPanels {...props} isAssistantOpen />);
    expect(screen.getByTestId('plan-assistant')).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Refinement instructions' })).toHaveValue('Split step 3 in two');
  });

  test('focuses the composer once a focus request reopens the hidden Assistant', () => {
    const view = render(<PlanEditorPanels {...props} isAssistantOpen={false} focusComposerRequest={1} />);
    view.rerender(<PlanEditorPanels {...props} isAssistantOpen focusComposerRequest={1} />);
    expect(screen.getByRole('textbox', { name: 'Refinement instructions' })).toHaveFocus();
  });
});
