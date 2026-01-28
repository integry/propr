import React from 'react';
import { SummarizationSettings } from '../../api/gitfixApi';

interface KnowledgeBaseSectionProps {
  settings: SummarizationSettings;
  onSettingsChange: (settings: SummarizationSettings, isPromptChange?: boolean) => void;
  onReindexAll?: () => void;
  isReindexing?: boolean;
  className?: string;
}

const KnowledgeBaseSection: React.FC<KnowledgeBaseSectionProps> = ({
  settings,
  onSettingsChange,
  onReindexAll,
  isReindexing = false,
  className
}) => {
  const handleToggleEnabled = () => {
    onSettingsChange({
      ...settings,
      enabled: !settings.enabled
    });
  };

  const handlePromptChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onSettingsChange({
      ...settings,
      custom_prompt: e.target.value
    }, true); // Mark as prompt change for debouncing
  };

  return (
    <div className={`bg-white shadow rounded-lg p-6 ${className || ''}`}>
      <h3 className="text-gray-900 text-lg font-medium mb-4">Knowledge Base</h3>
      <p className="text-sm text-gray-500 mb-4">
        Configure codebase indexing to enable semantic search across your repositories.
      </p>

      <div className="space-y-4">
        {/* Enable Toggle */}
        <div className="flex items-start">
          <div className="flex items-center h-5">
            <input
              type="checkbox"
              id="summarization_enabled"
              checked={settings.enabled}
              onChange={handleToggleEnabled}
              className="h-4 w-4 cursor-pointer rounded border-gray-300 text-primary-600 focus:ring-primary-500"
            />
          </div>
          <div className="ml-3">
            <label
              htmlFor="summarization_enabled"
              className="text-sm font-medium text-gray-700 cursor-pointer"
            >
              Enable Semantic Codebase Indexing
            </label>
            <p className="text-sm text-gray-500">
              Allows AI to search your codebase by meaning, not just filenames. Requires a configured Agent.
            </p>
          </div>
        </div>

        {/* Custom Prompt */}
        <div className={settings.enabled ? '' : 'opacity-50 pointer-events-none'}>
          <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="custom_prompt">
            Custom Summary Prompt (Optional)
          </label>
          <textarea
            id="custom_prompt"
            value={settings.custom_prompt || settings.default_prompt || ''}
            onChange={handlePromptChange}
            rows={5}
            className="w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm px-3 py-2 border disabled:bg-gray-100 disabled:cursor-not-allowed"
            placeholder="Enter custom summarization instructions..."
            disabled={!settings.enabled}
          />
          <p className="mt-1 text-sm text-gray-500">
            Define specific goals for the AI when summarizing files.
          </p>
          {/* Reindex button */}
          {onReindexAll && (
            <button
              type="button"
              onClick={onReindexAll}
              disabled={!settings.enabled || !settings.agent_alias || isReindexing}
              className="mt-3 inline-flex items-center px-3 py-1.5 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isReindexing ? (
                <>
                  <svg className="animate-spin -ml-0.5 mr-2 h-4 w-4 text-gray-500" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  Reindexing...
                </>
              ) : (
                <>
                  <svg className="-ml-0.5 mr-2 h-4 w-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  Reindex All Repositories
                </>
              )}
            </button>
          )}
        </div>

        {/* Warning if enabled but no agent selected */}
        {settings.enabled && !settings.agent_alias && (
          <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-md">
            <div className="flex">
              <svg className="h-5 w-5 text-yellow-400 mr-2 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <p className="text-sm text-yellow-700">
                Please select a summarization model in the AI Model Selection section above to enable indexing.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default KnowledgeBaseSection;
