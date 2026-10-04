import React from 'react';
import { SettingsField, SettingsSection, SettingsStatus } from './SettingsLayout';
import { SETTINGS_CHECKBOX, SETTINGS_CONTROL, SETTINGS_HELPER, SETTINGS_LABEL } from './settingsStyles';
import type { AgentTankMode } from '@propr/shared';

export interface AgentTankSettings {
  mode: AgentTankMode;
  enabled: boolean;
  url: string;
}

interface AgentTankSectionProps {
  settings: AgentTankSettings;
  onChange: (settings: AgentTankSettings) => void;
  onBlur?: () => void;
  className?: string;
  isAvailable?: boolean | null;
  isCheckingStatus?: boolean;
}

const MODE_OPTIONS: Array<{ value: AgentTankMode; label: string; description: string }> = [
  {
    value: 'disabled',
    label: 'Disabled',
    description: 'No usage tracking. Nothing is contacted or started.',
  },
  {
    value: 'bundled',
    label: 'Bundled (recommended)',
    description: 'ProPR runs Agent Tank inside the agent image using your configured agent credentials. No host install and no networking required.',
  },
  {
    value: 'external',
    label: 'External installation',
    description: 'Talk to an Agent Tank daemon you run yourself over HTTP.',
  },
];

/**
 * The three modes are mutually exclusive, so this is a radio group rather than
 * a checkbox: two booleans could express `disabled + bundled`, which is not a
 * real state.
 */
const AgentTankSection: React.FC<AgentTankSectionProps> = ({
  settings,
  onChange,
  onBlur,
  className,
  isAvailable,
  isCheckingStatus
}) => {
  const handleModeChange = (mode: AgentTankMode) => {
    onChange({ ...settings, mode, enabled: mode !== 'disabled' });
  };

  const handleUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange({
      ...settings,
      url: e.target.value
    });
  };

  // Bundled mode has no URL to be unreachable, so it gets its own wording:
  // telling an operator their daemon is unreachable would be misleading when
  // there is no daemon at all.
  const readyLabel = settings.mode === 'bundled' ? 'Bundled Agent Tank ready' : 'Agent Tank connected';
  const failedLabel = settings.mode === 'bundled' ? 'Bundled Agent Tank unavailable' : 'Agent Tank unreachable';

  const status = settings.mode === 'disabled' ? null
    : isCheckingStatus ? <SettingsStatus tone="pending" role="status">Checking connection…</SettingsStatus>
    : isAvailable === true ? <SettingsStatus tone="ok" role="status">{readyLabel}</SettingsStatus>
    : isAvailable === false ? <SettingsStatus tone="error" role="status">{failedLabel}</SettingsStatus>
    : null;

  return (
    <SettingsSection
      title="LLM Usage Tracking"
      status={status}
      description={
        <>
          Monitor LLM CLI usage limits with{' '}
          <a
            href="https://agenttank.io"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-primary-600 underline hover:text-primary-700"
          >
            Agent Tank
          </a>{' '}
          — see the{' '}
          <a
            href="https://docs.propr.dev/docs/operations/agent-tank"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-primary-600 underline hover:text-primary-700"
          >
            Agent Tank guide
          </a>
          .
        </>
      }
      className={className}
    >
      <fieldset className="mb-6 max-w-2xl">
        <legend className={SETTINGS_LABEL}>Integration mode</legend>
        <div className="mt-2 space-y-3">
          {MODE_OPTIONS.map(option => (
            <div key={option.value} className="flex items-start gap-3">
              <input
                type="radio"
                id={`agent_tank_mode_${option.value}`}
                name="agent_tank_mode"
                value={option.value}
                checked={settings.mode === option.value}
                onChange={() => handleModeChange(option.value)}
                className={SETTINGS_CHECKBOX}
              />
              <div className="min-w-0">
                <label className={`${SETTINGS_LABEL} cursor-pointer`} htmlFor={`agent_tank_mode_${option.value}`}>
                  {option.label}
                </label>
                <p className={SETTINGS_HELPER}>{option.description}</p>
              </div>
            </div>
          ))}
        </div>
      </fieldset>

      {settings.mode === 'external' && (
        <SettingsField
          label="Daemon URL"
          htmlFor="agent_tank_url"
          helperText={
            isAvailable === false
              ? `No Agent Tank daemon responded at ${settings.url || 'this address'}.`
              : 'The URL where the Agent Tank HTTP server is running.'
          }
        >
          <input
            type="text"
            id="agent_tank_url"
            value={settings.url}
            onChange={handleUrlChange}
            onBlur={onBlur}
            placeholder="http://0.0.0.0:3456"
            className={SETTINGS_CONTROL}
          />
        </SettingsField>
      )}
    </SettingsSection>
  );
};

export default AgentTankSection;
