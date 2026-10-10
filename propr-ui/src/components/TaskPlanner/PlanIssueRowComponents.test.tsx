import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { InstanceCatalogAgent } from '@propr/shared';
import type { PlanIssue } from '../../api/planIssuesApi';
import { IssueMetadata, RowActions, UltrafixSettingsControls } from './PlanIssueRowComponents';
import { AgentOverrideChip } from './AgentOverrideChip';
import { isOverriddenFromDefault } from './planIssueDefaultSelection';

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

describe('AgentOverrideChip dismissal and reset', () => {
  const defaultSelection = { agentAlias: 'claude', modelName: 'claude-opus-5-5' };
  const openPopover = () => fireEvent.click(screen.getByTestId('agent-override-chip'));

  it('closes on Escape and on a click outside, but not on a click inside', () => {
    render(<AgentOverrideChip {...chipProps} onModelChange={vi.fn()} />);
    openPopover();
    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    openPopover();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('hides "Reset to default" when the issue already uses the plan default', () => {
    render(<AgentOverrideChip {...chipProps} onModelChange={vi.fn()} defaultSelection={defaultSelection} />);
    openPopover();
    expect(screen.queryByRole('button', { name: 'Reset to default' })).not.toBeInTheDocument();
  });

  it('resets an overridden model back to the plan default', async () => {
    const onAgentChange = vi.fn();
    const onModelChange = vi.fn();
    const overridden = { ...issue, model_name: 'claude-sonnet-5-5' } as PlanIssue;
    render(<AgentOverrideChip {...chipProps} issue={overridden} onAgentChange={onAgentChange} onModelChange={onModelChange} defaultSelection={defaultSelection} />);
    openPopover();
    fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }));

    await waitFor(() => expect(onModelChange).toHaveBeenCalledWith(2799, 'claude-opus-5-5'));
    expect(onAgentChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('resets an overridden agent first, then applies the default model', async () => {
    const calls: string[] = [];
    let resolveAgent: () => void = () => {};
    const onAgentChange = vi.fn(() => new Promise<void>(resolve => { calls.push('agent'); resolveAgent = resolve; }));
    const onModelChange = vi.fn(() => { calls.push('model'); });
    const overridden = { ...issue, agent_alias: 'codex', model_name: 'gpt-6' } as PlanIssue;
    render(<AgentOverrideChip {...chipProps} issue={overridden} onAgentChange={onAgentChange} onModelChange={onModelChange} defaultSelection={defaultSelection} />);
    openPopover();
    fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }));

    expect(onAgentChange).toHaveBeenCalledWith(2799, 'claude');
    expect(onModelChange).not.toHaveBeenCalled();
    resolveAgent();
    await waitFor(() => expect(onModelChange).toHaveBeenCalledWith(2799, 'claude-opus-5-5'));
    expect(calls).toEqual(['agent', 'model']);
  });
});

describe('isOverriddenFromDefault', () => {
  const selection = { agentAlias: 'claude', modelName: 'claude-opus-5-5' };
  it.each([
    [{ agent_alias: 'claude', model_name: 'claude-opus-5-5' }, selection, false],
    [{ agent_alias: 'claude', model_name: null }, selection, false],
    [{ agent_alias: 'claude', model_name: 'claude-sonnet-5-5' }, selection, true],
    [{ agent_alias: 'codex', model_name: 'claude-opus-5-5' }, selection, true],
    [{ agent_alias: 'codex', model_name: null }, undefined, false],
    [{ agent_alias: 'codex', model_name: null }, { agentAlias: null, modelName: null }, false],
  ])('%o vs %o -> %s', (row, defaults, expected) => {
    expect(isOverriddenFromDefault(row, defaults)).toBe(expected);
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

describe('IssueMetadata', () => {
  const withPr = { ...issue, status: 'merged', pr_number: 2904 } as PlanIssue;

  it('shows the follow-up count and the review score trace, oldest first', () => {
    render(<IssueMetadata issue={{ ...withPr, followup_count: 3, review_scores: [6, 6, 9] }} />);
    expect(screen.getByText('3 follow-ups')).toBeInTheDocument();
    const trace = screen.getByTestId('review-score-trace');
    expect(trace).toHaveTextContent('6→6→9');
    expect(trace).toHaveAttribute('title', 'Review scores, oldest first: 6, 6, 9 out of 10');
  });

  it('leaves the trace out when the PR has no review scores', () => {
    render(<IssueMetadata issue={withPr} />);
    expect(screen.queryByTestId('review-score-trace')).not.toBeInTheDocument();
  });
});
