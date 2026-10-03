import React from 'react';
import { SettingsCheckboxField, SettingsField, SettingsSection } from './SettingsLayout';
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
  onBlur?: () => void;
  className?: string;
}

const GeneralSettingsSection: React.FC<GeneralSettingsSectionProps> = ({
  settings,
  onSettingChange,
  onBlur,
  className
}) => {
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
        <SettingsCheckboxField
          id="ultrafix_escalation_enabled" name="ultrafix_escalation_enabled"
          label="Automatic Escalation"
          helperText="When progress stalls, increase reasoning effort, then hand off to the next model. Disabled by default."
          checked={settings.ultrafix_escalation_enabled} onChange={onSettingChange} onBlur={onBlur}
        />
        <SettingsField label="Escalation Models (in order)" htmlFor="ultrafix_escalation_models"
          helperText="Comma-separated model names or agent:model pairs. The current implementation model always runs first. Providers at 90% usage are skipped when fresh Agent Tank data is available.">
          <input id="ultrafix_escalation_models" name="ultrafix_escalation_models"
            value={settings.ultrafix_escalation_models.join(', ')} onChange={onSettingChange} onBlur={onBlur}
            placeholder="codex:gpt-6-astra, claude:claude-opus-5-5" className={SETTINGS_CONTROL} />
        </SettingsField>
        <SettingsField label="Escalation Patience" htmlFor="ultrafix_escalation_patience"
          helperText="Stalled reviews before each escalation step. Any new best score resets this counter.">
          <input type="number" min={1} id="ultrafix_escalation_patience" name="ultrafix_escalation_patience"
            value={settings.ultrafix_escalation_patience} onChange={onSettingChange} onBlur={onBlur} className={SETTINGS_CONTROL} />
        </SettingsField>
        <SettingsField label="Max Reasoning Levels per Model" htmlFor="ultrafix_escalation_max_reasoning_levels"
          helperText="Maximum effort increases for each model. Use 0 to hand off directly after patience expires.">
          <input type="number" min={0} id="ultrafix_escalation_max_reasoning_levels" name="ultrafix_escalation_max_reasoning_levels"
            value={settings.ultrafix_escalation_max_reasoning_levels} onChange={onSettingChange} onBlur={onBlur} className={SETTINGS_CONTROL} />
        </SettingsField>
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
      </SettingsSection>
    </div>
  );
};

export default GeneralSettingsSection;
