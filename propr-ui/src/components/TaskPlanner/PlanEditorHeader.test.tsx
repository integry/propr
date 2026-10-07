import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PlanEditorHeader, type PlanEditorHeaderProps } from './PlanEditorComponents';
import { StudioStageContext } from './studioStageContext';

const baseProps: PlanEditorHeaderProps = {
  planName: 'Agents v1',
  repository: 'integry/propr',
  baseBranch: 'main',
  isDeleting: false,
  isFinalizing: false,
  isResettingToSetup: false,
  canUndo: true,
  canRedo: false,
  onDelete: vi.fn(),
  onBackToSetup: vi.fn(),
  onUndo: vi.fn(),
  onRedo: vi.fn(),
  onShowHistory: vi.fn(),
};

describe('PlanEditorHeader (desktop)', () => {
  it('groups undo, redo and history into one segmented pill', () => {
    render(<PlanEditorHeader {...baseProps} />);
    const pill = screen.getByTitle('Undo').parentElement!;
    expect(pill).toHaveClass('border', 'border-slate-200', 'rounded-md', 'bg-white', 'flex', 'divide-x');
    expect(pill).toContainElement(screen.getByTitle('Redo'));
    expect(pill).toContainElement(screen.getByTitle('Plan history'));
  });

  it('keeps Delete behind the overflow menu', () => {
    const onDelete = vi.fn();
    render(<PlanEditorHeader {...baseProps} onDelete={onDelete} />);
    expect(screen.queryByRole('menuitem', { name: /Delete plan/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'More plan actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete plan/ }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('toggles the Assistant pane', () => {
    const onToggleAssistant = vi.fn();
    render(<PlanEditorHeader {...baseProps} isAssistantOpen onToggleAssistant={onToggleAssistant} />);
    const toggle = screen.getByRole('button', { name: 'Assistant' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(toggle);
    expect(onToggleAssistant).toHaveBeenCalledTimes(1);
  });

  it('keeps the phase pill in the title group and truncates the title instead of overlapping the tool cluster', () => {
    render(
      <StudioStageContext.Provider value="review">
        <PlanEditorHeader {...baseProps} originalPrompt="Build agents" planLength={3} />
      </StudioStageContext.Provider>
    );
    const titleGroup = screen.getByTestId('plan-editor-title-group');
    const toolCluster = screen.getByTestId('plan-editor-tool-cluster');
    expect(titleGroup).toContainElement(screen.getByRole('navigation', { name: 'Plan phase' }));
    expect(toolCluster).toContainElement(screen.getByTitle('View original prompt'));
    // The group may shrink (so the page never widens), but only the title truncates; the pill keeps its width.
    expect(titleGroup).toHaveClass('min-w-0');
    expect(screen.getByRole('heading', { name: 'Agents v1' })).toHaveClass('min-w-0', 'truncate');
    expect(screen.getByRole('navigation', { name: 'Plan phase' })).toHaveClass('flex-shrink-0');
    expect(toolCluster).toHaveClass('flex-shrink-0');
    expect(titleGroup.parentElement).toHaveClass('gap-6');
  });
});

describe('PlanEditorHeader (mobile)', () => {
  it('shows the compact phase pill in the header instead of a separate stepper band', () => {
    render(
      <StudioStageContext.Provider value="review">
        <PlanEditorHeader {...baseProps} isMobile />
      </StudioStageContext.Provider>
    );
    const phases = screen.getByRole('navigation', { name: 'Plan phase' });
    expect(screen.getByTestId('plan-editor-mobile-meta-row')).toContainElement(phases);
    expect(phases.querySelector('[aria-current="step"]')).toHaveTextContent('2Review');
    expect(screen.queryByRole('navigation', { name: 'Progress' })).not.toBeInTheDocument();
  });
});
