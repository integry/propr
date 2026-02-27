import React from 'react';

interface GeneralSettings {
  worker_concurrency: string;
}

interface GeneralSettingsSectionProps {
  settings: GeneralSettings;
  onSettingChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
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
    </div>
  );
};

export default GeneralSettingsSection;
