import React from 'react';
import { SettingsCheckboxField, SettingsField, SettingsSection, SettingsStatus } from './SettingsLayout';
import { SETTINGS_CONTROL } from './settingsStyles';

export interface AgentTankSettings {
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

const AgentTankSection: React.FC<AgentTankSectionProps> = ({
  settings,
  onChange,
  onBlur,
  className,
  isAvailable,
  isCheckingStatus
}) => {
  const handleToggleEnabled = () => {
    onChange({
      ...settings,
      enabled: !settings.enabled
    });
  };

  const handleUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange({
      ...settings,
      url: e.target.value
    });
  };

  const status = !settings.enabled ? null
    : isCheckingStatus ? <SettingsStatus tone="pending" role="status">Checking connection…</SettingsStatus>
    : isAvailable === true ? <SettingsStatus tone="ok" role="status">Agent Tank connected</SettingsStatus>
    : isAvailable === false ? <SettingsStatus tone="error" role="status">Agent Tank unreachable</SettingsStatus>
    : null;

  return (
    <SettingsSection
      title="LLM Usage Tracking"
      status={status}
      description={
        <>
          Monitor LLM CLI usage limits via a local{' '}
          <a
            href="https://agenttank.io"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-primary-600 underline hover:text-primary-700"
          >
            Agent Tank
          </a>{' '}
          daemon — see the{' '}
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
      <SettingsCheckboxField
        id="agent_tank_enabled"
        label="Enable Agent Tank Integration"
        helperText="Track active session and rate limit usage for Claude, Antigravity, and Codex CLI tools."
        checked={settings.enabled}
        onChange={handleToggleEnabled}
      />

      <SettingsField
        label="Daemon URL"
        htmlFor="agent_tank_url"
        helperText={
          settings.enabled && isAvailable === false
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
          disabled={!settings.enabled}
          placeholder="http://0.0.0.0:3456"
          className={SETTINGS_CONTROL}
        />
      </SettingsField>
    </SettingsSection>
  );
};

export default AgentTankSection;
