import React from 'react';

interface GeneralSettings {
  worker_concurrency: string;
  auto_followup_score_threshold: number;
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
      </div>
    </div>
  );
};

export default GeneralSettingsSection;
