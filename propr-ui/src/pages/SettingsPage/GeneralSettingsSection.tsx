import React from 'react';
import { SettingsCheckboxField, SettingsField, SettingsSection } from './SettingsLayout';
import { SETTINGS_CONTROL } from './settingsStyles';

interface GeneralSettings {
  worker_concurrency: string;
  auto_resolve_merge_conflicts: boolean;
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
