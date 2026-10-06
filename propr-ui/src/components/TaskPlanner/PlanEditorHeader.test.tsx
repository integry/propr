import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PlanEditorHeader, type PlanEditorHeaderProps } from './PlanEditorComponents';

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
});
