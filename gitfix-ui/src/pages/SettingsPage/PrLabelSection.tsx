import React from 'react';

interface PrLabelSectionProps {
  prLabel: string;
  onLabelChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  className?: string;
}

const PrLabelSection: React.FC<PrLabelSectionProps> = ({
  prLabel,
  onLabelChange,
  className
}) => {
  return (
    <div className={`bg-white shadow rounded-lg p-6 ${className || ''}`}>
      <h3 className="text-gray-900 text-lg font-medium mb-2">PR Label</h3>
      <p className="text-gray-500 text-sm mb-4">
        Automatically added to all GitFix PRs. Used to monitor for follow-up comments.
      </p>
      
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="pr_label">
          Label Name
        </label>
        <input
          type="text"
          id="pr_label"
          name="pr_label"
          value={prLabel}
          onChange={onLabelChange}
          placeholder="e.g., gitfix"
          required
          className="w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm px-3 py-2 border"
        />
      </div>
    </div>
  );
};

export default PrLabelSection;