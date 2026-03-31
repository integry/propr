import React from 'react';

export interface AgentTankSettings {
  enabled: boolean;
  url: string;
}

interface AgentTankSectionProps {
  settings: AgentTankSettings;
  onChange: (settings: AgentTankSettings) => void;
  onBlur?: () => void;
  className?: string;
}

const AgentTankSection: React.FC<AgentTankSectionProps> = ({
  settings,
  onChange,
  onBlur,
  className
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

  return (
    <div className={className || ''}>
      <h4 className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-3">Agent Tank</h4>
      <p className="text-xs text-gray-500 mb-3">
        Monitor LLM CLI usage limits via a local Agent Tank daemon.
      </p>

      <div className="space-y-3">
        {/* Enable Toggle */}
        <div className="flex items-start">
          <div className="flex items-center h-5">
            <input
              type="checkbox"
              id="agent_tank_enabled"
              checked={settings.enabled}
              onChange={handleToggleEnabled}
              className="h-4 w-4 cursor-pointer rounded border-gray-300 text-primary-600 focus:ring-primary-500"
            />
          </div>
          <div className="ml-3">
            <label
              htmlFor="agent_tank_enabled"
              className="text-xs font-medium text-gray-700 cursor-pointer"
            >
              Enable Agent Tank Integration
            </label>
            <p className="text-xs text-gray-500">
              Track active session and rate limit usage for Claude, Gemini, and Codex CLI tools.
            </p>
          </div>
        </div>

        {/* Daemon URL */}
        <div className={settings.enabled ? '' : 'opacity-50 pointer-events-none'}>
          <label className="block text-xs font-medium text-gray-600 mb-1" htmlFor="agent_tank_url">
            Daemon URL
          </label>
          <input
            type="text"
            id="agent_tank_url"
            value={settings.url}
            onChange={handleUrlChange}
            onBlur={onBlur}
            disabled={!settings.enabled}
            placeholder="http://localhost:3456"
            className="w-full rounded border-gray-300 focus:border-primary-500 focus:ring-primary-500 text-sm px-2.5 py-1.5 border disabled:bg-gray-100 disabled:cursor-not-allowed"
          />
          <p className="mt-1 text-xs text-gray-500">
            The URL where the Agent Tank HTTP server is running.
          </p>
        </div>
      </div>
    </div>
  );
};

export default AgentTankSection;
