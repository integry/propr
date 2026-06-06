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

const CompactNumberField = ({
  label,
  htmlFor,
  helperText,
  children
}: {
  label: string;
  htmlFor: string;
  helperText: string;
  children: React.ReactNode;
}) => (
  <div>
    <label className="block text-xs font-medium text-gray-700 mb-1" htmlFor={htmlFor}>
      {label}
    </label>
    {children}
    <p className="mt-1 text-[11px] text-slate-500">{helperText}</p>
  </div>
);

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
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
          <CompactNumberField
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
            className="w-full max-w-[90px] rounded border-gray-300 focus:border-primary-500 focus:ring-primary-500 text-sm px-2 py-1.5 border"
          />
          </CompactNumberField>

          <CompactNumberField
            label="Auto-Followup Score Threshold"
            htmlFor="auto_followup_score_threshold"
            helperText="Post a retry follow-up when critique score is at or below this threshold. Set to 0 to disable."
          >
          <select
            id="auto_followup_score_threshold"
            name="auto_followup_score_threshold"
            value={settings.auto_followup_score_threshold}
            onChange={onSettingChange}
            onBlur={onBlur}
            className="w-full max-w-[160px] rounded border-gray-300 focus:border-primary-500 focus:ring-primary-500 text-sm px-2 py-1.5 border"
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
          </CompactNumberField>
        </div>

        <div className="flex items-start gap-3">
          <div className="flex h-5 items-start pt-0.5">
            <input
              type="checkbox"
              id="auto_resolve_merge_conflicts"
              name="auto_resolve_merge_conflicts"
              checked={settings.auto_resolve_merge_conflicts}
              onChange={onSettingChange}
              onBlur={onBlur}
              className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
            />
          </div>
          <div>
            <label className="text-sm font-medium text-gray-700" htmlFor="auto_resolve_merge_conflicts">
              Auto-Resolve Merge Conflicts
            </label>
            <p className="text-[11px] text-slate-500">
              When enabled, the system will automatically merge the PR base branch into contributor branches and ask an agent to resolve any conflicts. Disable this to prevent automatic mutation of open pull requests.
            </p>
          </div>
        </div>

        {/* Ultrafix Settings */}
        <div className="border-t border-gray-200 pt-4 mt-4">
          <h4 className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-3">Ultrafix</h4>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
            <CompactNumberField
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
                className="w-full max-w-[150px] rounded border-gray-300 focus:border-primary-500 focus:ring-primary-500 text-sm px-2 py-1.5 border"
              >
                {Array.from({ length: 10 }, (_, i) => i + 1).map(n => (
                  <option key={n} value={n}>
                    {n}{n === 7 ? ' (Default)' : ''}
                  </option>
                ))}
              </select>
            </CompactNumberField>

            <CompactNumberField
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
                className="w-full max-w-[90px] rounded border-gray-300 focus:border-primary-500 focus:ring-primary-500 text-sm px-2 py-1.5 border"
              />
            </CompactNumberField>

            <CompactNumberField
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
                className="w-full max-w-[90px] rounded border-gray-300 focus:border-primary-500 focus:ring-primary-500 text-sm px-2 py-1.5 border"
              />
            </CompactNumberField>
          </div>
        </div>
      </div>
    </div>
  );
};

export default GeneralSettingsSection;
