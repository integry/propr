import React from 'react';

interface PrLabelSectionProps {
  prLabel: string;
  onLabelChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onBlur?: () => void;
  className?: string;
}

const PrLabelSection: React.FC<PrLabelSectionProps> = ({
  prLabel,
  onLabelChange,
  onBlur,
  className
}) => {
  return (
    <div className={className || ''}>
      <h4 className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">PR Label</h4>
      <p className="text-gray-500 text-xs mb-3">
        Automatically added to all GitFix PRs. Used to monitor for follow-up comments.
      </p>

      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1" htmlFor="pr_label">
          Label Name
        </label>
        <input
          type="text"
          id="pr_label"
          name="pr_label"
          value={prLabel}
          onChange={onLabelChange}
          onBlur={onBlur}
          placeholder="e.g., gitfix"
          required
          className="w-full rounded border-gray-300 focus:border-primary-500 focus:ring-primary-500 text-sm px-2.5 py-1.5 border"
        />
      </div>
    </div>
  );
};

export default PrLabelSection;
