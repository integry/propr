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

  return (
    <div className={className || ''}>
      <h4 className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-3">LLM Usage Tracking</h4>
      <p className="text-xs text-gray-500 mb-3">
        Monitor LLM CLI usage limits via a local{' '}
        <a
          href="https://agenttank.io"
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary-600 hover:text-primary-700 underline"
        >
          Agent Tank
        </a>{' '}
        daemon.
      </p>

      <div className="space-y-3">
        {/* Enable Toggle */}
        <div className="flex items-start gap-3">
          <div className="flex h-5 items-start pt-0.5">
            <input
              type="checkbox"
              id="agent_tank_enabled"
              checked={settings.enabled}
              onChange={handleToggleEnabled}
              className="h-4 w-4 cursor-pointer rounded border-gray-300 text-primary-600 focus:ring-primary-500"
            />
          </div>
          <div>
            <label
              htmlFor="agent_tank_enabled"
              className="text-xs font-medium text-gray-700 cursor-pointer"
            >
              Enable Agent Tank Integration
            </label>
            <p className="text-[11px] text-slate-500">
              Track active session and rate limit usage for Claude, Gemini, and Codex CLI tools.
            </p>
          </div>
        </div>

        {/* Daemon URL */}
        <div className={`grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-4 items-start ${settings.enabled ? '' : 'opacity-50 pointer-events-none'}`}>
          <label className="block text-xs font-medium text-gray-600 pt-1.5" htmlFor="agent_tank_url">
            Daemon URL
          </label>
          <div>
            <input
              type="text"
              id="agent_tank_url"
              value={settings.url}
              onChange={handleUrlChange}
              onBlur={onBlur}
              disabled={!settings.enabled}
              placeholder="http://0.0.0.0:3456"
              className="w-full rounded border-gray-300 focus:border-primary-500 focus:ring-primary-500 text-sm px-2.5 py-1.5 border disabled:bg-gray-100 disabled:cursor-not-allowed"
            />
            <p className="mt-1 text-[11px] text-slate-500">
              The URL where the Agent Tank HTTP server is running.
            </p>
          </div>
        </div>

        {/* Connection Status */}
        {settings.enabled && (
          <div className="flex items-center gap-2 text-xs">
            {isCheckingStatus ? (
              <>
                <svg className="animate-spin h-3 w-3 text-gray-400" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                <span className="text-gray-500">Checking connection...</span>
              </>
            ) : isAvailable === true ? (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-green-500"></span>
                <span className="text-green-700">Agent Tank is connected</span>
              </>
            ) : isAvailable === false ? (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-red-500"></span>
                <span className="text-red-600">Agent Tank is not reachable at {settings.url}</span>
              </>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
};

export default AgentTankSection;
