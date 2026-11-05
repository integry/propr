import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import WorkflowSettingsSection from './WorkflowSettingsSection';
import UltrafixSettingsSection from './UltrafixSettingsSection';
import { parseLoadedData } from './parseLoadedData';
import { expectExistingDocsRoute } from './docsRoutes.testUtils';

const SETTINGS = {
  worker_concurrency: '2',
  max_provider_replacements: 2,
  auto_resolve_merge_conflicts: false,
  followup_requires_assignment: false,
  default_max_cost_usd: '',
};

const ULTRAFIX_SETTINGS = {
  ultrafix_escalation_enabled: false,
  ultrafix_escalation_models: [],
  ultrafix_escalation_patience: 3,
  ultrafix_escalation_max_reasoning_levels: 2,
  ultrafix_rating_goal: 7,
  ultrafix_max_cycles: 5,
  ultrafix_pause_seconds: 60,
};

it('shows the follow-up assignment toggle with copy covering unassigned tasks', () => {
  const onSettingChange = vi.fn(); const onBlur = vi.fn();
  render(<WorkflowSettingsSection settings={SETTINGS} onSettingChange={onSettingChange} onBlur={onBlur} />);
  const toggle = screen.getByLabelText('Follow-ups Only From Assigned Users');
  expect(toggle).not.toBeChecked();
  expect(screen.getByText(/Has no effect on a task nobody is assigned to/)).toBeInTheDocument();
  fireEvent.click(toggle); fireEvent.blur(toggle);
  expect(onSettingChange).toHaveBeenCalledOnce();
  expect(onSettingChange.mock.calls[0][0].target.name).toBe('followup_requires_assignment');
  expect(onBlur).toHaveBeenCalledOnce();
});

it('loads the follow-up assignment setting and defaults it to off', () => {
  const load = (settings: object) => parseLoadedData([settings, {}, {}, {}, {}, {}, {}, {}]).settings;
  expect(load({}).followup_requires_assignment).toBe(false);
  expect(load({ followup_requires_assignment: true }).followup_requires_assignment).toBe(true);
});

it('groups follow-up and merge defaults apart from processing limits', () => {
  render(<WorkflowSettingsSection settings={SETTINGS} onSettingChange={vi.fn()} />);
  const processing = screen.getByRole('region', { name: 'Processing' });
  const defaults = screen.getByRole('region', { name: 'Repository defaults' });
  expect(processing).toContainElement(screen.getByLabelText('Worker Concurrency'));
  expect(processing).toContainElement(screen.getByLabelText('Default Spend Cap per Run (USD)'));
  expect(defaults).toContainElement(screen.getByLabelText('Auto-Resolve Merge Conflicts (default for repositories)'));
  expect(defaults).toContainElement(screen.getByLabelText('Follow-ups Only From Assigned Users'));
  expect(screen.queryByLabelText(/Max Cycles/)).toBeNull();
});

it('names the ultrafix goal a target review score out of 10', () => {
  render(<UltrafixSettingsSection settings={ULTRAFIX_SETTINGS} onSettingChange={vi.fn()} modelAgents={[]} onEscalationModelsChange={vi.fn()} />);
  const target = screen.getByLabelText('Target Review Score');
  expect(target).toHaveValue('7');
  expect(screen.getByRole('option', { name: '7/10 (Default)' })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: '10/10' })).toBeInTheDocument();
  expect(screen.queryByText('Rating Goal')).toBeNull();
});

it('links the ultrafix docs to an existing docs page and heading', () => {
  render(<UltrafixSettingsSection settings={ULTRAFIX_SETTINGS} onSettingChange={vi.fn()} modelAgents={[]} onEscalationModelsChange={vi.fn()} />);
  expectExistingDocsRoute(screen.getByRole('link', { name: 'Ultrafix docs' }).getAttribute('href'));
});

it.each([
  ['openai/gpt-5.5', 'GPT-5.5'],
  ['claude-sonnet-9-1-20990101', 'Claude Sonnet 9.1'],
])('shows a readable unavailable escalation model label for %s while retaining its ID', (modelId, displayName) => {
  const onEscalationModelsChange = vi.fn();
  render(<UltrafixSettingsSection
    settings={{ ...ULTRAFIX_SETTINGS, ultrafix_escalation_enabled: true, ultrafix_escalation_models: [modelId] }}
    onSettingChange={vi.fn()} modelAgents={[]} onEscalationModelsChange={onEscalationModelsChange}
  />);

  const modelSelect = screen.getByRole('combobox', { name: 'Escalation model 1' });
  const option = screen.getByRole('option', { name: `${displayName} (unavailable)` });
  expect(modelSelect).toHaveValue(modelId);
  expect(option).toHaveAttribute('value', modelId);
  expect(screen.queryByText(`${modelId} (unavailable)`)).toBeNull();

  fireEvent.change(modelSelect, { target: { value: modelId } });
  expect(onEscalationModelsChange).toHaveBeenCalledWith([modelId]);
});
