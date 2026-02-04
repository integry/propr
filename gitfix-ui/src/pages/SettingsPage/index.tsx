import React from 'react';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import GeneralSettingsSection from './GeneralSettingsSection';
import AIModelSelectionSection from './AIModelSelectionSection';
import PrLabelSection from './PrLabelSection';
import TagListSection from './TagListSection';
import KnowledgeBaseSection from './KnowledgeBaseSection';
import { useSettingsState } from './useSettingsState';

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
      <div className="p-8 text-center text-gray-500">
        Loading settings configuration...
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto pb-8">
      <div className="flex justify-between items-center mb-8">
        <h2 className="text-gray-900 text-2xl font-semibold">Settings</h2>
        {/* Auto-save status indicator */}
        <div className="flex items-center gap-2">
          {saveStatus === 'saving' && (
            <span className="flex items-center gap-1.5 text-sm text-gray-500">
              <svg className="animate-spin h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              Saving...
            </span>
          )}
          {saveStatus === 'saved' && (
            <span className="flex items-center gap-1.5 text-sm text-green-600">
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              Saved
            </span>
          )}
          {saveStatus === 'error' && globalError && (
            <span className="flex items-center gap-1.5 text-sm text-red-600">
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {globalError}
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left Column */}
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

          <GeneralSettingsSection
            settings={{ worker_concurrency: settings.worker_concurrency }}
            onSettingChange={(e) =>
              setSettings(prev => ({ ...prev, [e.target.name]: e.target.value }))
            }
            onBlur={triggerAutoSave}
          />
        </div>

        {/* Right Column */}
        <div className="space-y-6">
          <div className="bg-white shadow rounded-lg p-6">
            <h2 className="text-xl font-semibold text-gray-900 mb-6">GitHub Processing Rules</h2>

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
              className="shadow-none p-0 border-0"
            />

            <div className="border-t border-gray-200 my-6"></div>

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
              className="shadow-none p-0 border-0"
            />

            <div className="border-t border-gray-200 my-6"></div>

            <PrLabelSection
              prLabel={prLabel}
              onLabelChange={(e) => setPrLabel(e.target.value)}
              onBlur={triggerAutoSave}
              className="shadow-none p-0 border-0"
            />

            <div className="border-t border-gray-200 my-6"></div>

            <TagListSection
              title="Follow-up Keywords"
              description="Triggers processing when found in comments."
              items={keywords}
              newItem={newKeyword}
              onNewItemChange={setNewKeyword}
              onAddItem={addKeyword}
              onRemoveItem={removeKeyword}
              placeholder="e.g., GITFIX"
              emptyMessage="No keywords configured."
              showEmptyIcon={true}
              className="shadow-none p-0 border-0"
            />

            <div className="border-t border-gray-200 my-6"></div>

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
              className="shadow-none p-0 border-0"
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default SettingsPage;
