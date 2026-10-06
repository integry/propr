import React from 'react';
import { SettingsCheckboxField, SettingsField, SettingsSection } from './SettingsLayout';
import { buildAllModelOptions, type ModelSelectionAgent } from './modelSelectionHelpers';
import { SETTINGS_CONTROL } from './settingsStyles';
import { DEFAULT_MAX_PROVIDER_REPLACEMENTS, MAX_PROVIDER_REPLACEMENTS_LIMIT } from '@propr/shared';

interface GeneralSettings {
  worker_concurrency: string;
  max_provider_replacements: number;
  auto_resolve_merge_conflicts: boolean;
  ultrafix_escalation_enabled: boolean;
  ultrafix_escalation_models: string[];
  ultrafix_escalation_patience: number;
  ultrafix_escalation_max_reasoning_levels: number;
  ultrafix_rating_goal: number;
  ultrafix_max_cycles: number;
  ultrafix_pause_seconds: number;
  default_max_cost_usd: string;
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

        <SettingsField
          label="Provider Failure Replacements"
          htmlFor="max_provider_replacements"
          helperText="Replacement runs started automatically when a run ends with a transient provider error (for example 5xx or overloaded). 0 disables them. Usage limits (429) are re-queued separately."
        >
          <select
            id="max_provider_replacements"
            name="max_provider_replacements"
            value={settings.max_provider_replacements}
            onChange={onSettingChange}
            onBlur={onBlur}
            className={SETTINGS_CONTROL}
          >
            {Array.from({ length: MAX_PROVIDER_REPLACEMENTS_LIMIT + 1 }, (_, i) => i).map(n => (
              <option key={n} value={n}>
                {n === 0 ? '0 (Disabled)' : n}{n === DEFAULT_MAX_PROVIDER_REPLACEMENTS ? ' (Default)' : ''}
              </option>
            ))}
          </select>
        </SettingsField>

        <SettingsCheckboxField
          id="auto_resolve_merge_conflicts"
          name="auto_resolve_merge_conflicts"
          label="Auto-Resolve Merge Conflicts (default for repositories)"
          helperText="Default for repositories that do not set their own value in Repositories → Automation. When on, ProPR merges the base branch into its conflicted pull requests and asks an agent to resolve the conflicts. A repository set to Always or Never overrides this default."
          checked={settings.auto_resolve_merge_conflicts}
          onChange={onSettingChange}
          onBlur={onBlur}
        />

        <SettingsField
          label="Default Spend Cap per Run (USD)"
          htmlFor="default_max_cost_usd"
          helperText="Stops an implementation, follow-up, /fix, ultrafix cycle or review once its estimated cost reaches this amount and publishes its partial work. Leave empty or 0 for no cap. A task's own cap and the repository's .propr/workflow.yml limits.max_cost_usd take precedence."
        >
          <input
            type="number"
            id="default_max_cost_usd"
            name="default_max_cost_usd"
            value={settings.default_max_cost_usd}
            onChange={onSettingChange}
            onBlur={onBlur}
            min={0}
            step="0.01"
            placeholder="No cap"
            className={SETTINGS_CONTROL}
          />
        </SettingsField>
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
          helperText="When scores stall, raise reasoning effort, then switch models. E.g. medium → high, then next model."
          checked={settings.ultrafix_escalation_enabled} onChange={onSettingChange} onBlur={onBlur}
        />
        {settings.ultrafix_escalation_enabled && (
          <>
            <SettingsField label="Escalation Models (in order)" htmlFor={models.length ? "ultrafix_escalation_model_0" : "ultrafix_escalation_model_add"}
              helperText="Tried in order after the current model. Unavailable or usage-exhausted models are skipped.">
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
    </div>
  );
};

export default GeneralSettingsSection;
