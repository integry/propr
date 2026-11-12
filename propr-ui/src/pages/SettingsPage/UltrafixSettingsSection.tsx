import React from 'react';
import { SettingsCheckboxField, SettingsField, SettingsSection } from './SettingsLayout';
import { buildAllModelOptions, type ModelSelectionAgent } from './modelSelectionHelpers';
import { SETTINGS_CONTROL } from './settingsStyles';
import EscalationModelListField from './EscalationModelListField';

interface UltrafixSettings {
  ultrafix_escalation_enabled: boolean;
  ultrafix_escalation_models: string[];
  ultrafix_escalation_patience: number;
  ultrafix_escalation_max_reasoning_levels: number;
  ultrafix_rating_goal: number;
  ultrafix_max_cycles: number;
  ultrafix_pause_seconds: number;
}

interface UltrafixSettingsSectionProps {
  settings: UltrafixSettings;
  onSettingChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => void;
  modelAgents: ModelSelectionAgent[];
  onEscalationModelsChange: (models: string[]) => void;
  onBlur?: () => void;
  className?: string;
}

const UltrafixSettingsSection: React.FC<UltrafixSettingsSectionProps> = ({
  settings,
  onSettingChange,
  onBlur,
  modelAgents,
  onEscalationModelsChange,
  className
}) => {
  const modelOptions = buildAllModelOptions(modelAgents);
  const models = settings.ultrafix_escalation_models;
  return (
    <SettingsSection
      title="Ultrafix"
      className={className}
      description={
        <>
          Repeated fix-and-review cycles until a pull request reaches the target review score.{' '}
          <a
            href="https://docs.propr.dev/docs/features/pr-commands#ultrafix"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-primary-600 underline hover:text-primary-700"
          >
            Ultrafix docs
          </a>
        </>
      }
    >
      <SettingsField
        label="Target Review Score"
        htmlFor="ultrafix_rating_goal"
        helperText="Ultrafix stops once a review scores at least this high."
      >
        <select
          id="ultrafix_rating_goal"
          name="ultrafix_rating_goal"
          value={settings.ultrafix_rating_goal}
          onChange={onSettingChange}
          onBlur={onBlur}
          className={SETTINGS_CONTROL}
        >
          {Array.from({ length: 10 }, (_, i) => i + 1).map(n => (
            <option key={n} value={n}>
              {n}/10{n === 7 ? ' (Default)' : ''}
            </option>
          ))}
        </select>
      </SettingsField>

      <SettingsField
        label="Max Cycles"
        htmlFor="ultrafix_max_cycles"
        helperText="Maximum fix-review cycles before stopping."
      >
        <input
          type="number"
          id="ultrafix_max_cycles"
          name="ultrafix_max_cycles"
          value={settings.ultrafix_max_cycles}
          onChange={onSettingChange}
          onBlur={onBlur}
          min={1}
          placeholder="5"
          className={SETTINGS_CONTROL}
        />
      </SettingsField>

      <SettingsField
        label="Pause Between Cycles"
        htmlFor="ultrafix_pause_seconds"
        helperText="Seconds to wait between each ultrafix cycle."
      >
        <input
          type="number"
          id="ultrafix_pause_seconds"
          name="ultrafix_pause_seconds"
          value={settings.ultrafix_pause_seconds}
          onChange={onSettingChange}
          onBlur={onBlur}
          min={0}
          placeholder="60"
          className={SETTINGS_CONTROL}
        />
      </SettingsField>

      <SettingsCheckboxField
        id="ultrafix_escalation_enabled" name="ultrafix_escalation_enabled"
        label="Automatic Escalation"
        helperText="When scores stall, raise reasoning effort, then switch models. E.g. medium → high, then next model."
        checked={settings.ultrafix_escalation_enabled} onChange={onSettingChange} onBlur={onBlur}
      />
      {settings.ultrafix_escalation_enabled && (
        <>
          <EscalationModelListField idPrefix="ultrafix_escalation_model" ariaLabel="Escalation model" label="Escalation Models (in order)"
            helperText="Tried in order after the current model. Unavailable or usage-exhausted models are skipped."
            models={models} modelOptions={modelOptions} onChange={onEscalationModelsChange} />
          <SettingsField label="Escalation Patience" htmlFor="ultrafix_escalation_patience"
            helperText="Reviews without a new best score before escalating. E.g. 2: best 6/10, then 6 and 5 → escalate.">
            <input type="number" min={1} id="ultrafix_escalation_patience" name="ultrafix_escalation_patience"
              value={settings.ultrafix_escalation_patience} onChange={onSettingChange} onBlur={onBlur} className={SETTINGS_CONTROL} />
          </SettingsField>
          <SettingsField label="Max Reasoning Levels per Model" htmlFor="ultrafix_escalation_max_reasoning_levels"
            helperText="Effort increases per model before switching. E.g. 2: low → medium → high → next model. 0 switches right away.">
            <input type="number" min={0} id="ultrafix_escalation_max_reasoning_levels" name="ultrafix_escalation_max_reasoning_levels"
              value={settings.ultrafix_escalation_max_reasoning_levels} onChange={onSettingChange} onBlur={onBlur} className={SETTINGS_CONTROL} />
          </SettingsField>
        </>
      )}
    </SettingsSection>
  );
};

export default UltrafixSettingsSection;
