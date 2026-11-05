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
    </SettingsSection>

    <SettingsSection title="Repository defaults">
      <SettingsCheckboxField
        id="auto_resolve_merge_conflicts"
        name="auto_resolve_merge_conflicts"
        label="Auto-Resolve Merge Conflicts (default for repositories)"
        helperText="Default for repositories that do not set their own value in Repositories → Automation. When on, ProPR merges the base branch into its conflicted pull requests and asks an agent to resolve the conflicts. A repository set to Always or Never overrides this default."
        checked={settings.auto_resolve_merge_conflicts}
        onChange={onSettingChange}
        onBlur={onBlur}
      />

      <SettingsCheckboxField
        id="followup_requires_assignment"
        name="followup_requires_assignment"
        label="Follow-ups Only From Assigned Users"
        helperText="When on, a comment starts follow-up work on a task only if its author is assigned to that task; comments from other allowed users are not processed as follow-ups. Has no effect on a task nobody is assigned to: any allowed user can still start follow-ups there."
        checked={settings.followup_requires_assignment}
        onChange={onSettingChange}
        onBlur={onBlur}
      />
    </SettingsSection>
  </div>
);

export default WorkflowSettingsSection;
