import React from 'react';
import { SettingsCheckboxField, SettingsField, SettingsSection } from './SettingsLayout';
import { buildAllModelOptions, type ModelSelectionAgent } from './modelSelectionHelpers';
import { SETTINGS_CONTROL } from './settingsStyles';

interface GeneralSettings {
  worker_concurrency: string;
  auto_resolve_merge_conflicts: boolean;
  ultrafix_escalation_enabled: boolean;
  ultrafix_escalation_models: string[];
  ultrafix_escalation_patience: number;
  ultrafix_escalation_max_reasoning_levels: number;
  ultrafix_rating_goal: number;
  ultrafix_max_cycles: number;
  ultrafix_pause_seconds: number;
}

interface GeneralSettingsSectionProps {
  settings: GeneralSettings;
  onSettingChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => void;
  modelAgents: ModelSelectionAgent[];
  onEscalationModelsChange: (models: string[]) => void;
  onBlur?: () => void;
  className?: string;
}

const GeneralSettingsSection: React.FC<GeneralSettingsSectionProps> = ({
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
    <div className={`space-y-10 ${className || ''}`}>
      <SettingsSection title="Processing">
        <SettingsField
          label="Worker Concurrency"
          htmlFor="worker_concurrency"
          helperText="Number of issues to process simultaneously."
        >
          <input
            type="number"
            id="worker_concurrency"
            name="worker_concurrency"
            value={settings.worker_concurrency}
            onChange={onSettingChange}
            onBlur={onBlur}
            placeholder="2"
            className={SETTINGS_CONTROL}
          />
        </SettingsField>

        <SettingsCheckboxField
          id="auto_resolve_merge_conflicts"
          name="auto_resolve_merge_conflicts"
          label="Auto-Resolve Merge Conflicts"
          helperText="When enabled, the system will automatically merge the PR base branch into contributor branches and ask an agent to resolve any conflicts. Disable this to prevent automatic mutation of open pull requests."
          checked={settings.auto_resolve_merge_conflicts}
          onChange={onSettingChange}
          onBlur={onBlur}
        />
      </SettingsSection>

      <SettingsSection
        title="Ultrafix"
        description={
          <>
            Repeated fix-and-review cycles until a pull request reaches the target quality rating.{' '}
            <a
              href="https://docs.propr.dev/docs/features/pr-ultrafix-commands"
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
          label="Rating Goal"
          htmlFor="ultrafix_rating_goal"
          helperText="Target quality rating (1-10)."
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
                {n}{n === 7 ? ' (Default)' : ''}
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
          helperText="Let Ultrafix increase reasoning effort and switch models when review scores stop improving. For example, try medium → high effort on the current model before switching to the first escalation model. Disabled by default."
          checked={settings.ultrafix_escalation_enabled} onChange={onSettingChange} onBlur={onBlur}
        />
        {settings.ultrafix_escalation_enabled && (
          <>
            <SettingsField label="Escalation Models (in order)" htmlFor={models.length ? "ultrafix_escalation_model_0" : "ultrafix_escalation_model_add"}
              helperText="Models to try after the current implementation model, in the order shown. For example, if the first model in this list is unavailable, Ultrafix tries the second. If none are available, it keeps the current model. Agent Tank is optional; when available, usage at 100% blocks switching to that model.">
              <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-2">
                {models.map((model, index) => (
                  <div key={index} className="contents">
                    <span className="text-sm text-gray-500">{index + 1}.</span>
                    <select id={`ultrafix_escalation_model_${index}`} aria-label={`Escalation model ${index + 1}`}
                      value={model} className={`${SETTINGS_CONTROL} min-w-0`}
                      onChange={event => onEscalationModelsChange(models.map((value, i) => i === index ? event.target.value : value))}>
                      {!modelOptions.some(option => option.value === model) && <option value={model}>{model} (unavailable)</option>}
                      {modelOptions.map(option => <option key={option.value} value={option.value}>
                        {option.label}{option.enabled ? '' : ' (disabled)'}
                      </option>)}
                    </select>
                    <button type="button" aria-label={`Remove escalation model ${index + 1}`}
                      onClick={() => onEscalationModelsChange(models.filter((_, i) => i !== index))}
                      className="text-sm text-gray-600 hover:text-gray-900">Remove</button>
                  </div>
                ))}
                <select id="ultrafix_escalation_model_add" aria-label="Add escalation model" value="" className={`${SETTINGS_CONTROL} col-start-2 min-w-0`}
                  onChange={event => { if (event.target.value) onEscalationModelsChange([...models, event.target.value]); }}>
                  <option value="">Add escalation model…</option>
                  {modelOptions.map(option => <option key={option.value} value={option.value}>
                    {option.label}{option.enabled ? '' : ' (disabled)'}
                  </option>)}
                </select>
              </div>
            </SettingsField>
            <SettingsField label="Escalation Patience" htmlFor="ultrafix_escalation_patience"
              helperText="Number of consecutive reviews without a new best score before increasing effort or switching models. For example, with patience 2 and a best score of 6/10, reviews of 6/10 then 5/10 trigger one step. A score of 7/10 resets the counter. The counter also resets after each step.">
              <input type="number" min={1} id="ultrafix_escalation_patience" name="ultrafix_escalation_patience"
                value={settings.ultrafix_escalation_patience} onChange={onSettingChange} onBlur={onBlur} className={SETTINGS_CONTROL} />
            </SettingsField>
            <SettingsField label="Max Reasoning Levels per Model" htmlFor="ultrafix_escalation_max_reasoning_levels"
              helperText="Maximum number of reasoning effort increases allowed on each model, starting from its initial effort. For example, 2 allows low → medium → high on a model that supports those levels, with a full patience wait before each increase. After another patience wait, Ultrafix tries the next model. It switches sooner if no higher effort is available. Set 0 to skip effort increases and switch models after the first patience wait.">
              <input type="number" min={0} id="ultrafix_escalation_max_reasoning_levels" name="ultrafix_escalation_max_reasoning_levels"
                value={settings.ultrafix_escalation_max_reasoning_levels} onChange={onSettingChange} onBlur={onBlur} className={SETTINGS_CONTROL} />
            </SettingsField>
          </>
        )}
      </SettingsSection>
    </div>
  );
};

export default GeneralSettingsSection;
