import React from 'react';

interface GeneralSettings {
  worker_concurrency: string;
  auto_followup_score_threshold: number;
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
    <div className={className || ''}>
      <h4 className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-4">General Configuration</h4>

      <div className="space-y-4">
        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-gray-700" htmlFor="worker_concurrency">
            Worker Concurrency
          </label>
          <input
            type="number"
            id="worker_concurrency"
            name="worker_concurrency"
            value={settings.worker_concurrency}
            onChange={onSettingChange}
            onBlur={onBlur}
            placeholder="2"
            className="max-w-[80px] rounded border-gray-300 focus:border-primary-500 focus:ring-primary-500 text-sm px-2 py-1.5 border"
          />
          <p className="text-xs text-gray-500">Number of issues to process simultaneously.</p>
        </div>

        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-gray-700" htmlFor="auto_followup_score_threshold">
            Auto-Followup Score Threshold
          </label>
          <select
            id="auto_followup_score_threshold"
            name="auto_followup_score_threshold"
            value={settings.auto_followup_score_threshold}
            onChange={onSettingChange}
            onBlur={onBlur}
            className="max-w-[150px] rounded border-gray-300 focus:border-primary-500 focus:ring-primary-500 text-sm px-2 py-1.5 border"
          >
            <option value={0}>Disabled</option>
            <option value={1}>1 (Very Low)</option>
            <option value={2}>2</option>
            <option value={3}>3</option>
            <option value={4}>4 (Default)</option>
            <option value={5}>5</option>
            <option value={6}>6</option>
            <option value={7}>7</option>
            <option value={8}>8</option>
            <option value={9}>9 (High)</option>
          </select>
          <p className="text-xs text-gray-500">
            When an implementation critique score is at or below this threshold, automatically post a follow-up comment to trigger a retry. Set to 0 to disable.
          </p>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="auto_resolve_merge_conflicts"
              name="auto_resolve_merge_conflicts"
              checked={settings.auto_resolve_merge_conflicts}
              onChange={onSettingChange}
              onBlur={onBlur}
              className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
            />
            <label className="text-sm font-medium text-gray-700" htmlFor="auto_resolve_merge_conflicts">
              Auto-Resolve Merge Conflicts
            </label>
          </div>
          <p className="text-xs text-gray-500">
            When enabled, the system will automatically merge the PR base branch into contributor branches and ask an agent to resolve any conflicts. Disable this to prevent automatic mutation of open pull requests.
          </p>
        </div>

        {/* Ultrafix Settings */}
        <div className="border-t border-gray-200 pt-4 mt-4">
          <h4 className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-3">Ultrafix</h4>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-gray-700" htmlFor="ultrafix_rating_goal">
                Rating Goal
              </label>
              <select
                id="ultrafix_rating_goal"
                name="ultrafix_rating_goal"
                value={settings.ultrafix_rating_goal}
                onChange={onSettingChange}
                onBlur={onBlur}
                className="max-w-[150px] rounded border-gray-300 focus:border-primary-500 focus:ring-primary-500 text-sm px-2 py-1.5 border"
              >
                {Array.from({ length: 10 }, (_, i) => i + 1).map(n => (
                  <option key={n} value={n}>
                    {n}{n === 7 ? ' (Default)' : ''}
                  </option>
                ))}
              </select>
              <p className="text-xs text-gray-500">
                Target quality rating (1-10). Ultrafix will keep iterating until this score is reached.
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-gray-700" htmlFor="ultrafix_max_cycles">
                Max Cycles
              </label>
              <input
                type="number"
                id="ultrafix_max_cycles"
                name="ultrafix_max_cycles"
                value={settings.ultrafix_max_cycles}
                onChange={onSettingChange}
                onBlur={onBlur}
                min={1}
                placeholder="5"
                className="max-w-[80px] rounded border-gray-300 focus:border-primary-500 focus:ring-primary-500 text-sm px-2 py-1.5 border"
              />
              <p className="text-xs text-gray-500">
                Maximum number of fix-review cycles before stopping (positive integer).
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-gray-700" htmlFor="ultrafix_pause_seconds">
                Pause Between Cycles (seconds)
              </label>
              <input
                type="number"
                id="ultrafix_pause_seconds"
                name="ultrafix_pause_seconds"
                value={settings.ultrafix_pause_seconds}
                onChange={onSettingChange}
                onBlur={onBlur}
                min={0}
                placeholder="60"
                className="max-w-[80px] rounded border-gray-300 focus:border-primary-500 focus:ring-primary-500 text-sm px-2 py-1.5 border"
              />
              <p className="text-xs text-gray-500">
                Seconds to wait between each ultrafix cycle (non-negative integer).
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default GeneralSettingsSection;
