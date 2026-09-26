import React from 'react';
import { RefreshCw } from 'lucide-react';
import { SummarizationSettings } from '../../api/proprApi';
import { SettingsCheckboxField, SettingsField, SettingsSection } from './SettingsLayout';
import { SETTINGS_CONTROL } from './settingsStyles';

interface KnowledgeBaseSectionProps {
  settings: SummarizationSettings;
  onSettingsChange: (settings: SummarizationSettings, isPromptChange?: boolean) => void;
  onReindexAll?: (ignoreCooldown?: boolean) => void;
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
  const hasCooldown = Object.keys(settings.runtime?.cooldowns || {}).length > 0;
  const handleIgnoreCooldown = () => {
    const confirmed = window.confirm('Ignore summarization cooldowns and reindex all repositories now? This can consume quota immediately.');
    if (confirmed) {
      onReindexAll?.(true);
    }
  };

  return (
    <SettingsSection
      title="Knowledge Base"
      description="Configure codebase indexing to enable semantic search across your repositories."
      className={className}
    >
      <SettingsCheckboxField
        id="summarization_enabled"
        label="Enable Semantic Codebase Indexing"
        helperText="Allows AI to search your codebase by meaning, not just filenames. Requires a configured Agent."
        checked={settings.enabled}
        onChange={handleToggleEnabled}
      />

      <SettingsField
        label="Custom Summary Prompt (Optional)"
        htmlFor="custom_prompt"
        helperText="Define specific goals for the AI when summarizing files."
      >
        <textarea
          id="custom_prompt"
          value={settings.custom_prompt || settings.default_prompt || ''}
          onChange={handlePromptChange}
          rows={4}
          className={SETTINGS_CONTROL}
          placeholder="Enter custom summarization instructions..."
          disabled={!settings.enabled}
        />
      </SettingsField>

      {onReindexAll && (
        <div className="mb-6 flex max-w-2xl flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onReindexAll(false)}
            disabled={!settings.enabled || !settings.agent_alias || isReindexing}
            className="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400 disabled:hover:bg-white"
          >
            <RefreshCw aria-hidden="true" className={`h-3.5 w-3.5 ${isReindexing ? 'animate-spin' : ''}`} />
            {isReindexing ? 'Reindexing...' : 'Reindex All Repositories'}
          </button>
          {hasCooldown && (
            <button
              type="button"
              onClick={handleIgnoreCooldown}
              disabled={!settings.enabled || !settings.agent_alias || isReindexing}
              className="inline-flex items-center rounded px-2.5 py-1.5 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
            >
              Queue Once Despite Cooldown
            </button>
          )}
        </div>
      )}

      {settings.enabled && !settings.agent_alias && (
        <p className="max-w-2xl text-[12px] leading-5 text-amber-700">
          Select a Summarization Model under AI &amp; Models → Planning to enable indexing.
        </p>
      )}
    </SettingsSection>
  );
};

export default KnowledgeBaseSection;
