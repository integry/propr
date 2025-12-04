import React from 'react';
import Alert from './Alert';

interface PrLabelSectionProps {
  prLabel: string;
  loading: boolean;
  saving: boolean;
  error: string | null;
  success: string | null;
  onLabelChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onSave: () => void;
}

const PrLabelSection: React.FC<PrLabelSectionProps> = ({
  prLabel,
  loading,
  saving,
  error,
  success,
  onLabelChange,
  onSave
}) => {
  const isDisabled = saving || !prLabel || prLabel.trim() === '';

  return (
    <div className="mb-8">
      <h3 className="text-gray-900 text-xl font-semibold mb-4">PR Label</h3>
      <p className="text-gray-600 mb-4">
        Configure the label that will be automatically added to all PRs created by GitFix. 
        Only PRs with this label will be monitored for follow-up comments.
      </p>
      
      {error && <Alert message={error} type="error" />}
      {success && <Alert message={success} type="success" />}
      
      {loading ? (
        <p className="text-gray-600">Loading PR label...</p>
      ) : (
        <div className="space-y-4">
          <div>
            <label className="block text-gray-700 mb-2" htmlFor="pr_label">
              PR Label <span className="text-red-600">*</span>
            </label>
            <input
              type="text"
              id="pr_label"
              name="pr_label"
              value={prLabel}
              onChange={onLabelChange}
              placeholder="e.g., gitfix"
              required
              className="w-full px-3 py-2 bg-gray-50 text-gray-900 border border-gray-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
            />
            <p className="mt-1 text-sm text-gray-600">
              This label will be added to all PRs created by GitFix and used to filter follow-up comments
            </p>
          </div>

          <button
            onClick={onSave}
            disabled={isDisabled}
            className={`px-6 py-3 font-medium rounded-md transition-colors ${
              isDisabled
                ? 'bg-gray-300 text-gray-600 cursor-not-allowed'
                : 'bg-primary-600 text-white hover:bg-primary-700 cursor-pointer'
            }`}
          >
            {saving ? 'Saving...' : 'Save PR Label'}
          </button>
        </div>
      )}
    </div>
  );
};

export default PrLabelSection;
