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
      <div className="flex items-center justify-between gap-6">
        <div className="flex items-center gap-4">
          <h4 className="text-[10px] font-bold uppercase tracking-wider text-gray-500">General Configuration</h4>
        </div>

        <div className="flex items-center gap-3">
          <label className="text-xs font-medium text-gray-600 whitespace-nowrap" htmlFor="worker_concurrency">
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
            className="w-16 rounded border-gray-300 focus:border-primary-500 focus:ring-primary-500 text-sm px-2 py-1 border text-center"
          />
          <span className="text-xs text-gray-500">issues processed simultaneously</span>
        </div>
      </div>
    </div>
  );
};

export default GeneralSettingsSection;
