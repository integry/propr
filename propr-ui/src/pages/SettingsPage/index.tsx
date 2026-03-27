import React from 'react';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import GeneralSettingsSection from './GeneralSettingsSection';
import AIModelSelectionSection from './AIModelSelectionSection';
import PrLabelSection from './PrLabelSection';
import TagListSection from './TagListSection';
import KnowledgeBaseSection from './KnowledgeBaseSection';
import { useSettingsState } from './useSettingsState';
import { API_BASE_URL } from '../../api/proprApi';

const SettingsPage: React.FC = () => {
  useDocumentTitle('Settings');

  const {
    loading,
    saveStatus,
    globalError,
    settings,
    prLabel,
    whitelist,
    newWhitelistItem,
    primaryLabels,
    newPrimaryLabel,
    keywords,
    newKeyword,
    ignoreKeywords,
    newIgnoreKeyword,
    agents,
    summarizationSettings,
    isReindexing,
    setSettings,
    setPrLabel,
    setNewWhitelistItem,
    setNewPrimaryLabel,
    setNewKeyword,
    setNewIgnoreKeyword,
    triggerAutoSave,
    handleModelSelectionChange,
    addWhitelistItem,
    removeWhitelistItem,
    addPrimaryLabel,
    removePrimaryLabel,
    addKeyword,
    removeKeyword,
    addIgnoreKeyword,
    removeIgnoreKeyword,
    handleSummarizationChange,
    handleSummarizationModelChange,
    handleDefaultAgentChange,
    handleReindexAll
  } = useSettingsState();

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-white text-gray-500">
        Loading settings configuration...
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Anchored Header */}
      <div className="flex-shrink-0 border-b border-gray-200 px-6 py-4">
        <h2 className="text-gray-900 text-xl font-semibold">Settings</h2>
      </div>

      {/* Main Content Area - 2 Column Split */}
      <div className="flex-1 flex flex-col md:flex-row min-h-0 overflow-y-auto md:overflow-hidden">
        {/* Left Column - AI Engine Configuration */}
        <div className="w-full md:w-1/2 md:overflow-y-auto border-b md:border-b-0 md:border-r border-gray-200 p-6">
          <h3 className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-4">AI Engine Configuration</h3>

          <div className="space-y-6">
            <AIModelSelectionSection
              settings={{
                analysis_model_fast: settings.analysis_model_fast,
                planner_context_model: settings.planner_context_model,
                planner_generation_model: settings.planner_generation_model,
                default_agent_alias: settings.default_agent_alias
              }}
              summarizationSettings={summarizationSettings}
              agents={agents}
              onSettingChange={handleModelSelectionChange}
              onSummarizationModelChange={handleSummarizationModelChange}
              onDefaultAgentChange={handleDefaultAgentChange}
            />

            <KnowledgeBaseSection
              settings={summarizationSettings}
              onSettingsChange={handleSummarizationChange}
              onReindexAll={handleReindexAll}
              isReindexing={isReindexing}
            />
          </div>
        </div>

        {/* Right Column - Automation Rules */}
        <div className="w-full md:w-1/2 md:overflow-y-auto p-6">
          <h3 className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-4">Automation Rules</h3>

          <div className="space-y-6">
            <TagListSection
              title="GitHub User Whitelist"
              description="Only process issues/comments from these users."
              items={whitelist}
              newItem={newWhitelistItem}
              onNewItemChange={setNewWhitelistItem}
              onAddItem={addWhitelistItem}
              onRemoveItem={removeWhitelistItem}
              placeholder="e.g., octocat"
              emptyMessage="Allowed for all users (Empty whitelist)."
            />

            <TagListSection
              title="Primary Processing Labels"
              description="Issues with these labels will be auto-processed."
              items={primaryLabels}
              newItem={newPrimaryLabel}
              onNewItemChange={setNewPrimaryLabel}
              onAddItem={addPrimaryLabel}
              onRemoveItem={removePrimaryLabel}
              placeholder="e.g., AI"
              emptyMessage="No labels configured."
              helperText="State labels (-processing, -done) are generated automatically."
            />

            <PrLabelSection
              prLabel={prLabel}
              onLabelChange={(e) => setPrLabel(e.target.value)}
              onBlur={triggerAutoSave}
            />

            <TagListSection
              title="Follow-up Keywords"
              description="Triggers processing when found in comments."
              items={keywords}
              newItem={newKeyword}
              onNewItemChange={setNewKeyword}
              onAddItem={addKeyword}
              onRemoveItem={removeKeyword}
              placeholder="e.g., PROPR"
              emptyMessage="No keywords configured."
              showEmptyIcon={true}
            />

            <TagListSection
              title="PR Follow-up Ignore Keywords"
              description="Ignore comments containing these phrases (prevents loops)."
              items={ignoreKeywords}
              newItem={newIgnoreKeyword}
              onNewItemChange={setNewIgnoreKeyword}
              onAddItem={addIgnoreKeyword}
              onRemoveItem={removeIgnoreKeyword}
              placeholder="e.g., Deployment In Progress"
              emptyMessage="No ignore keywords configured."
              showEmptyIcon={true}
            />

            {/* Horizontal divider */}
            <div className="border-t border-gray-200 pt-6">
              <GeneralSettingsSection
                settings={{
                  worker_concurrency: settings.worker_concurrency,
                  auto_followup_score_threshold: settings.auto_followup_score_threshold,
                  auto_resolve_merge_conflicts: settings.auto_resolve_merge_conflicts
                }}
                onSettingChange={(e) => {
                  let value: string | number | boolean;
                  if (e.target.name === 'auto_followup_score_threshold') {
                    value = parseInt(e.target.value, 10);
                  } else if (e.target.name === 'auto_resolve_merge_conflicts') {
                    value = (e.target as HTMLInputElement).checked;
                  } else {
                    value = e.target.value;
                  }
                  setSettings(prev => ({ ...prev, [e.target.name]: value }));
                }}
                onBlur={triggerAutoSave}
              />
            </div>

            {/* CLI Quick Start */}
            <div className="border-t border-gray-200 pt-6">
              <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                <h4 className="text-xs font-semibold text-gray-700 mb-2">ProPR CLI</h4>
                <p className="text-xs text-gray-500 mb-3">
                  Manage plans, tasks, and repos from the command line.
                </p>
                <div className="space-y-1.5 font-mono text-[11px] text-gray-600 bg-white rounded border border-gray-200 p-3">
                  <div className="text-gray-400"># Install & authenticate</div>
                  <div>npm install -g @propr/cli</div>
                  <div>propr remote {API_BASE_URL || window.location.origin}</div>
                  <div>propr login</div>
                  <div>propr use owner/repo</div>
                  <div className="mt-2 text-gray-400"># Create a plan</div>
                  <div>propr plan create "Add auth" --wait</div>
                  <div>propr plan finalize &lt;draft-id&gt;</div>
                  <div>propr plan issues &lt;draft-id&gt;</div>
                  <div className="mt-2 text-gray-400"># Implement & monitor</div>
                  <div>propr issue implement &lt;id&gt;/1 --wait</div>
                  <div>propr task list -s processing</div>
                  <div>propr task get &lt;task-id&gt;</div>
                </div>
                <p className="text-[10px] text-gray-400 mt-2">
                  Run <span className="font-mono">propr --help</span> for all commands.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Anchored Footer - Status Bar */}
      <div className="flex-shrink-0 border-t border-gray-200 px-6 py-3 bg-gray-50">
        <div className="flex items-center justify-between">
          {/* Left Side - Status Message */}
          <div className="flex items-center gap-2">
            {saveStatus === 'saving' && (
              <span className="flex items-center gap-1.5 text-xs text-gray-500 font-mono">
                <svg className="animate-spin h-3 w-3 text-gray-400" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Saving changes...
              </span>
            )}
            {saveStatus === 'saved' && (
              <span className="flex items-center gap-1.5 text-xs text-gray-500 font-mono">
                <span className="w-1.5 h-1.5 rounded-full bg-green-500"></span>
                Settings auto-saved
              </span>
            )}
            {saveStatus === 'error' && globalError && (
              <span className="flex items-center gap-1.5 text-xs text-red-600 font-mono">
                <span className="w-1.5 h-1.5 rounded-full bg-red-500"></span>
                {globalError}
              </span>
            )}
            {saveStatus === 'idle' && (
              <span className="flex items-center gap-1.5 text-xs text-gray-400 font-mono">
                <span className="w-1.5 h-1.5 rounded-full bg-gray-300"></span>
                All changes saved
              </span>
            )}
          </div>

          {/* Right Side - Reserved for action buttons if not using auto-save */}
          <div className="flex items-center gap-2">
            {/* Action buttons would go here if needed */}
          </div>
        </div>
      </div>
    </div>
  );
};

export default SettingsPage;
