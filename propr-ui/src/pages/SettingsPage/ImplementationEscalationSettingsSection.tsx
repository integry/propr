import React from 'react';
import { SettingsCheckboxField, SettingsField, SettingsSection } from './SettingsLayout';
import { buildAllModelOptions, type ModelSelectionAgent } from './modelSelectionHelpers';
import { SETTINGS_CONTROL } from './settingsStyles';
import EscalationModelListField from './EscalationModelListField';

export interface ImplementationEscalationSettings {
  implementation_escalation_enabled: boolean;
  implementation_escalation_models: string[];
  implementation_escalation_max_reasoning_levels: number;
  implementation_escalation_validation_followup: boolean;
}

interface ImplementationEscalationSettingsSectionProps {
  settings: ImplementationEscalationSettings;
  onSettingChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => void;
  modelAgents: ModelSelectionAgent[];
  onModelsChange: (models: string[]) => void;
  onBlur?: () => void;
}

/** Escalation of issue implementation runs: start cheap, climb only after a failed attempt or failed validation. */
const ImplementationEscalationSettingsSection: React.FC<ImplementationEscalationSettingsSectionProps> = ({
  settings, onSettingChange, modelAgents, onModelsChange, onBlur,
}) => {
  const ladderUsed = settings.implementation_escalation_enabled || settings.implementation_escalation_validation_followup;
  return (
    <SettingsSection
      title="Implementation Escalation"
      description={
        <>
          Start implementation runs at their configured model and effort, and escalate only after a failure.{' '}
          <a
            href="https://docs.propr.dev/docs/features/pr-commands#implementation-escalation"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-primary-600 underline hover:text-primary-700"
          >
            Escalation docs
          </a>
        </>
      }
    >
      <SettingsCheckboxField
        id="implementation_escalation_enabled" name="implementation_escalation_enabled"
        label="Escalate Failed Attempts"
        helperText="When a failed run is replaced automatically, the replacement runs one reasoning level higher, then hands off to the next model. Usage-limit retries never escalate."
        checked={settings.implementation_escalation_enabled} onChange={onSettingChange} onBlur={onBlur}
      />
      <SettingsCheckboxField
        id="implementation_escalation_validation_followup" name="implementation_escalation_validation_followup"
        label="Follow Up on Failed Validation"
        helperText="When repository validation fails on a new pull request, run one automatic follow-up one step higher to fix the failing commands. At most once per task."
        checked={settings.implementation_escalation_validation_followup} onChange={onSettingChange} onBlur={onBlur}
      />
      {ladderUsed && (
        <>
          <EscalationModelListField idPrefix="implementation_escalation_model" ariaLabel="Implementation escalation model"
            label="Escalation Models (in order)"
            helperText="Tried in order once the reasoning increases are used up. Unavailable or usage-exhausted models are skipped."
            models={settings.implementation_escalation_models} modelOptions={buildAllModelOptions(modelAgents)} onChange={onModelsChange} />
          <SettingsField label="Max Reasoning Levels per Model" htmlFor="implementation_escalation_max_reasoning_levels"
            helperText="Effort increases per model before handing off. E.g. 2: medium → high → xhigh → next model. 0 hands off right away.">
            <input type="number" min={0} id="implementation_escalation_max_reasoning_levels" name="implementation_escalation_max_reasoning_levels"
              value={settings.implementation_escalation_max_reasoning_levels} onChange={onSettingChange} onBlur={onBlur} className={SETTINGS_CONTROL} />
          </SettingsField>
        </>
      )}
    </SettingsSection>
  );
};

export default ImplementationEscalationSettingsSection;
