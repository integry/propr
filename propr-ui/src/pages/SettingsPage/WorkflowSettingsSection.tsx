import React from 'react';
import { SettingsCheckboxField, SettingsField, SettingsSection } from './SettingsLayout';
import { SETTINGS_CONTROL } from './settingsStyles';
import { DEFAULT_MAX_PROVIDER_REPLACEMENTS, MAX_PROVIDER_REPLACEMENTS_LIMIT } from '@propr/shared';

interface WorkflowSettings {
  worker_concurrency: string;
  max_provider_replacements: number;
  auto_resolve_merge_conflicts: boolean;
  followup_requires_assignment: boolean;
  default_max_cost_usd: string;
}

interface WorkflowSettingsSectionProps {
  settings: WorkflowSettings;
  onSettingChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => void;
  onBlur?: () => void;
  className?: string;
}

const WorkflowSettingsSection: React.FC<WorkflowSettingsSectionProps> = ({
  settings,
  onSettingChange,
  onBlur,
  className
}) => (
  <div className={`space-y-10 ${className || ''}`}>
    <SettingsSection title="Processing">
      <SettingsField
        label="Worker concurrency"
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
        label="Default spend cap per run (USD)"
        htmlFor="default_max_cost_usd"
        helperText="Stops a run when its estimated cost reaches this amount. Empty or 0 means no cap."
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

      <SettingsField
        label="Provider failure replacements"
        htmlFor="max_provider_replacements"
        helperText="Automatic retries after a provider error. 0 turns them off."
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
              {n === 0 ? '0 (disabled)' : n}{n === DEFAULT_MAX_PROVIDER_REPLACEMENTS ? ' (default)' : ''}
            </option>
          ))}
        </select>
      </SettingsField>
    </SettingsSection>

    <SettingsSection title="Repository defaults">
      <SettingsCheckboxField
        id="auto_resolve_merge_conflicts"
        name="auto_resolve_merge_conflicts"
        label="Auto-resolve merge conflicts (default for repositories)"
        helperText="Default for repositories that have not chosen their own setting."
        checked={settings.auto_resolve_merge_conflicts}
        onChange={onSettingChange}
        onBlur={onBlur}
      />

      <SettingsCheckboxField
        id="followup_requires_assignment"
        name="followup_requires_assignment"
        label="Follow-ups only from assigned users"
        helperText="Only the people assigned to a task can start follow-ups by commenting. Unassigned tasks are not affected."
        checked={settings.followup_requires_assignment}
        onChange={onSettingChange}
        onBlur={onBlur}
      />
    </SettingsSection>
  </div>
);

export default WorkflowSettingsSection;
