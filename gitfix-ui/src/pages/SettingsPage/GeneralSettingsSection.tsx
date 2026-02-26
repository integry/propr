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
    <div className={`bg-white shadow rounded-lg p-6 ${className || ''}`}>
      <h3 className="text-gray-900 text-lg font-medium mb-4">General Configuration</h3>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="worker_concurrency">
            Worker Concurrency
          </label>
          <input
            type="number"
            id="worker_concurrency"
            name="worker_concurrency"
            value={settings.worker_concurrency}
            onChange={onSettingChange}
            onBlur={onBlur}
            placeholder="e.g., 2"
            className="w-[100px] rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm px-3 py-2 border"
          />
          <p className="mt-1 text-sm text-gray-500">
            Number of issues to process simultaneously.
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="auto_followup_score_threshold">
            Auto-Followup Score Threshold
          </label>
          <select
            id="auto_followup_score_threshold"
            name="auto_followup_score_threshold"
            value={settings.auto_followup_score_threshold}
            onChange={onSettingChange}
            onBlur={onBlur}
            className="w-[150px] rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm px-3 py-2 border"
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
          <p className="mt-1 text-sm text-gray-500">
            When an implementation critique score is at or below this threshold, automatically post a follow-up comment to trigger a retry. Set to 0 to disable.
          </p>
        </div>
      </div>
    </div>
  );
};

export default GeneralSettingsSection;
