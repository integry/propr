import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import ImplementationEscalationSettingsSection, { type ImplementationEscalationSettings } from './ImplementationEscalationSettingsSection';
import { parseLoadedData } from './parseLoadedData';

const agents = [{ alias: 'claude', enabled: true, supportedModels: ['claude-sonnet-5-5', 'claude-opus-5-5'] }];
const off: ImplementationEscalationSettings = {
  implementation_escalation_enabled: false, implementation_escalation_models: [],
  implementation_escalation_max_reasoning_levels: 2, implementation_escalation_validation_followup: false,
};

function renderSection(settings: ImplementationEscalationSettings) {
  const onSettingChange = vi.fn(); const onModelsChange = vi.fn();
  render(<ImplementationEscalationSettingsSection settings={settings} modelAgents={agents} onSettingChange={onSettingChange} onModelsChange={onModelsChange} />);
  return { onSettingChange, onModelsChange };
}

it('shows both triggers off and hides the ladder until one is enabled', () => {
  const { onSettingChange } = renderSection(off);
  expect(screen.getByLabelText('Escalate Failed Attempts')).not.toBeChecked();
  expect(screen.getByLabelText('Follow Up on Failed Validation')).not.toBeChecked();
  expect(screen.queryByLabelText('Max Reasoning Levels per Model')).not.toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('Escalate Failed Attempts'));
  expect(onSettingChange).toHaveBeenCalledOnce();
});

it('edits the ladder when only the validation follow-up is enabled', () => {
  const { onModelsChange } = renderSection({ ...off, implementation_escalation_validation_followup: true, implementation_escalation_models: ['claude:claude-opus-5-5'] });
  expect(screen.getByLabelText('Max Reasoning Levels per Model')).toHaveValue(2);
  expect(screen.getByLabelText('Implementation escalation model 1')).toHaveValue('claude:claude-opus-5-5');
  fireEvent.change(screen.getByLabelText('Add implementation escalation model'), { target: { value: 'claude:claude-sonnet-5-5' } });
  expect(onModelsChange).toHaveBeenCalledWith(['claude:claude-opus-5-5', 'claude:claude-sonnet-5-5']);
  fireEvent.click(screen.getByLabelText('Remove implementation escalation model 1'));
  expect(onModelsChange).toHaveBeenLastCalledWith([]);
});

it('loads the persisted group and defaults it to off on older servers', () => {
  const load = (settings: object) => parseLoadedData([settings, {}, {}, {}, {}, {}, {}, {}]).settings;
  expect(load({})).toMatchObject(off);
  expect(load({ implementation_escalation_enabled: true, implementation_escalation_models: ['codex:gpt-6'], implementation_escalation_max_reasoning_levels: 0 }))
    .toMatchObject({ implementation_escalation_enabled: true, implementation_escalation_models: ['codex:gpt-6'], implementation_escalation_max_reasoning_levels: 0 });
});
