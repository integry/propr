import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import GeneralSettingsSection from './GeneralSettingsSection';
import { parseLoadedData } from './parseLoadedData';

const SETTINGS = {
  worker_concurrency: '2',
  max_provider_replacements: 2,
  auto_resolve_merge_conflicts: false,
  followup_requires_assignment: false,
  ultrafix_escalation_enabled: false,
  ultrafix_escalation_models: [],
  ultrafix_escalation_patience: 3,
  ultrafix_escalation_max_reasoning_levels: 2,
  ultrafix_rating_goal: 7,
  ultrafix_max_cycles: 5,
  ultrafix_pause_seconds: 60,
  default_max_cost_usd: '',
};

it('shows the follow-up assignment toggle with copy covering unassigned tasks', () => {
  const onSettingChange = vi.fn(); const onBlur = vi.fn();
  render(<GeneralSettingsSection settings={SETTINGS} onSettingChange={onSettingChange} onBlur={onBlur} modelAgents={[]} onEscalationModelsChange={vi.fn()} />);
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
