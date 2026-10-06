import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { InstanceCatalogAgent } from '@propr/shared';
import type { PlanIssue } from '../../api/planIssuesApi';
import { RowActions, UltrafixSettingsControls } from './PlanIssueRowComponents';
import { AgentOverrideChip } from './AgentOverrideChip';

const issue = {
  id: 1, draft_id: 'd', repository: 'integry/propr', issue_number: 2799, pr_number: null, status: 'pending',
  agent_alias: 'claude', model_name: 'claude-opus-5-5', followup_count: 0, task_id: null,
  created_at: '', updated_at: '',
} as PlanIssue;

const agents = [
  { alias: 'claude', enabled: true, supportedModels: ['claude-opus-5-5', 'claude-sonnet-5-5'], defaultModel: 'claude-opus-5-5' },
] as unknown as InstanceCatalogAgent[];

const chipProps = {
  agents, issue, disabled: false, isMultiMode: false, selectedModels: [],
  onAgentChange: vi.fn(), handleMultiToggle: vi.fn(), handleMultiModelChange: vi.fn(), handleImplementClick: vi.fn(),
};

describe('AgentOverrideChip', () => {
  it('shows the agent as a compact chip and only renders selects in the override popover', () => {
    const onModelChange = vi.fn();
    render(<AgentOverrideChip {...chipProps} onModelChange={onModelChange} />);

    expect(screen.getByTestId('agent-override-chip')).toHaveTextContent('Opus 5.5');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('agent-override-chip'));
    expect(screen.getByRole('dialog', { name: 'Agent override for #2799' })).toBeInTheDocument();
    fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'claude-sonnet-5-5' } });
    expect(onModelChange).toHaveBeenCalledWith(2799, 'claude-sonnet-5-5');

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('UltrafixSettingsControls', () => {
  it('labels the goal as a review score with its tier and scale', () => {
    render(
      <UltrafixSettingsControls
        enabled goal={8} maxCycles={5} onGoalChange={vi.fn()} onMaxCyclesChange={vi.fn()}
        goalPlaceholder="Default" maxPlaceholder="Default" inputClassName="" goalInputWidthClassName="" maxInputWidthClassName=""
      />
    );

    const goal = screen.getByLabelText('Min Review Score') as HTMLSelectElement;
    expect(goal.selectedOptions[0].textContent).toBe('◆ 8/10 (Standard)');
    expect(screen.getByLabelText('Max Loops')).toHaveValue(5);
  });
});

describe('RowActions', () => {
  const rowProps = {
    hasExpandableContent: false, isExpanded: false, implementing: false, isMultiMode: false, selectedModels: [],
    hasAgent: true, isFirstPending: true, agents, onAgentChange: vi.fn(), onModelChange: vi.fn(),
    handleMultiToggle: vi.fn(), handleMultiModelChange: vi.fn(), handleImplementClick: vi.fn(), handleToggleExpand: vi.fn(),
  };

  it.each([
    ['pending', { ...issue }, 'agent-override-chip', 'Implement'],
    ['running', { ...issue, status: 'processing', task_id: 'task-1' } as PlanIssue, 'agent-chip', 'View Progress'],
  ])('keeps the agent column before the action column for a %s row', (_state, rowIssue, chipTestId, action) => {
    const { container } = render(
      <MemoryRouter><RowActions {...rowProps} issue={rowIssue} isPending={rowIssue.status === 'pending'} /></MemoryRouter>
    );

    const columns = Array.from(container.querySelectorAll('[data-testid$="-column"]')).map(el => el.getAttribute('data-testid'));
    expect(columns).toEqual(['agent-column', 'action-column']);
    expect(within(screen.getByTestId('agent-column')).getByTestId(chipTestId)).toHaveTextContent('Opus 5.5');
    expect(screen.getByTestId('action-column')).toHaveTextContent(action);
  });
});
