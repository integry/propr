import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ExecutionOptionsToolbar } from './PlanIssuesManagerToolbar';
import type { PlanTask } from '../../api/plannerApi';

const tasks = [
  { id: 'task-1', title: 'First', body: '', implementation: '' },
  { id: 'task-2', title: 'Second', body: '', implementation: '' },
] as PlanTask[];

const renderToolbar = (overrides: Partial<React.ComponentProps<typeof ExecutionOptionsToolbar>> = {}) => render(
  <ExecutionOptionsToolbar
    agents={[]}
    globalAgent="claude"
    globalModel="claude-opus-5-5"
    globalIsMulti={false}
    globalSelectedModels={[]}
    applyingGlobal={false}
    handleGlobalAgentChange={vi.fn()}
    handleGlobalModelChange={vi.fn()}
    handleGlobalMultiToggle={vi.fn()}
    handleGlobalMultiModelChange={vi.fn()}
    handleApplyToAll={vi.fn()}
    autoMerge
    runUltrafix
    ultrafixGoal={8}
    useEpic={false}
    tasks={tasks}
    {...overrides}
  />
);

describe('ExecutionOptionsToolbar mobile layout', () => {
  it('keeps the mode switcher and the config button on one non-wrapping row on phones', () => {
    renderToolbar();
    const bar = screen.getByTestId('execution-options-bar');
    const toggle = screen.getByTestId('execution-mode-toggle');
    const configButton = screen.getByTestId('execution-config-button');

    expect(toggle.parentElement).toBe(bar);
    expect(bar).toContainElement(configButton);
    expect(bar).toHaveClass('flex-nowrap', 'sm:flex-wrap');
    expect(toggle).toHaveClass('flex-shrink-0');
    // The summary is the only part that gives way, by truncating.
    expect(configButton).toHaveClass('max-w-full');
    expect(configButton.parentElement).toHaveClass('min-w-0');
    expect(screen.getByText(/Ultrafix \(8\/10\) · Auto-merge/)).toHaveClass('truncate');
  });

  it('uses short mode labels and drops the Config label on phones while keeping full accessible names', () => {
    const onUseEpicChange = vi.fn();
    renderToolbar({ onUseEpicChange });

    expect(screen.getByText('Epic PR')).toHaveClass('sm:hidden');
    expect(screen.getByText('Individual')).toHaveClass('sm:hidden');
    expect(screen.getByText('Execute as Individual Tasks')).toHaveClass('hidden', 'sm:inline');
    expect(screen.getByText('Config:')).toHaveClass('sr-only', 'sm:not-sr-only');
    expect(screen.getByRole('radio', { name: 'Execute as Individual Tasks' })).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(screen.getByRole('radio', { name: 'Execute as Epic PR' }));
    expect(onUseEpicChange).toHaveBeenCalledWith(true);
  });
});
