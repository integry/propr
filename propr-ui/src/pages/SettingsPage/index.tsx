import React from 'react';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import GeneralSettingsSection from './GeneralSettingsSection';
import AIModelSelectionSection from './AIModelSelectionSection';
import PrLabelSection from './PrLabelSection';
import TagListSection from './TagListSection';
import KnowledgeBaseSection from './KnowledgeBaseSection';
import AgentTankSection from './AgentTankSection';
import AgentRuntimePackagesSection from './AgentRuntimePackagesSection';
import { useSettingsState } from './useSettingsState';
import { useDemoMode } from '../../contexts/DemoModeContext';
import { useCurrentUser, userHasPermission } from '../../contexts/AuthContext';
import NotificationSettingsSection from './NotificationSettingsSection';
import VisualPreviewAuthSection from './VisualPreviewAuthSection';
import DesktopNotificationSettingsSection from './DesktopNotificationSettingsSection';
import DesktopVoiceSettingsSection from './DesktopVoiceSettingsSection';
import { useDesktop } from '../../desktop/DesktopContext';
import ManagedPreviewStorageSection from './ManagedPreviewStorageSection';
import SettingsNavigation, { type SettingsNavigationSection } from './SettingsNavigation';
import McpServerSection from './McpServerSection';

const AdminSettingsPage: React.FC = () => {
  const { isDemoMode } = useDemoMode();
  const desktop = useDesktop();

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
    catalogAgents,
    summarizationSettings,
    isReindexing,
    agentTankSettings,
    agentTankAvailable,
    agentTankCheckingStatus,
    setSettings,
    setPrLabel,
    setNewWhitelistItem,
    setNewPrimaryLabel,
    setNewKeyword,
    setNewIgnoreKeyword,
    triggerSettingsSave,
    handleModelSelectionChange,
    handleReviewContextEnabledChange,
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
    handleSummarizationFallbackModelChange,
    handleDefaultAgentChange,
    handleReindexAll,
    handleAgentTankChange,
    savePrLabelOnly
  } = useSettingsState();

  const handleGeneralSettingChange = (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const settingName = event.target.name;
    let value: string | number | boolean;
    const numericFields = ['auto_followup_score_threshold', 'ultrafix_rating_goal', 'ultrafix_max_cycles', 'ultrafix_pause_seconds'];
    if (numericFields.includes(settingName)) {
      const raw = event.target.value;
      // Only accept strings that are strictly integer digits (with optional leading minus)
      // to avoid silent coercion of values like "1e6" or "2.5".
      if (raw === '' || !/^-?\d+$/.test(raw)) return;
      const parsed = Number(raw);
      if (!Number.isSafeInteger(parsed)) return;
      value = parsed;
    } else if (settingName === 'auto_resolve_merge_conflicts') {
      value = (event.target as HTMLInputElement).checked;
    } else {
      value = event.target.value;
    }
    setSettings(previous => ({ ...previous, [settingName]: value }));
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-white text-gray-500">
        Loading settings configuration...
      </div>
    );
  }

  const settingsSections: SettingsNavigationSection[] = [
    {
      id: 'model-selection',
      category: 'models',
      searchText: 'model selection AI implementation agent reasoning level planning context analysis plan generation summarization fallback pull request PR review prompt review context token limit',
      content: (
        <AIModelSelectionSection
          settings={{
            analysis_model_fast: settings.analysis_model_fast,
            planner_context_model: settings.planner_context_model,
            planner_generation_model: settings.planner_generation_model,
            default_agent_alias: settings.default_agent_alias,
            model_reasoning_level: settings.model_reasoning_level,
            pr_review_model: settings.pr_review_model,
            pr_review_prompt: settings.pr_review_prompt,
            pr_review_context_enabled: settings.pr_review_context_enabled,
            pr_review_context_model: settings.pr_review_context_model,
            pr_review_max_context_tokens: settings.pr_review_max_context_tokens
          }}
          summarizationSettings={summarizationSettings}
          agents={agents}
          catalogAgents={catalogAgents}
          onSettingChange={handleModelSelectionChange}
          onReviewPromptChange={(event) => setSettings(previous => ({ ...previous, pr_review_prompt: event.target.value }))}
          onReviewPromptBlur={triggerSettingsSave}
          onReviewContextEnabledChange={handleReviewContextEnabledChange}
          onReviewMaxContextTokensChange={(value) => setSettings(previous => ({ ...previous, pr_review_max_context_tokens: value }))}
          onReviewMaxContextTokensBlur={triggerSettingsSave}
          onSummarizationModelChange={handleSummarizationModelChange}
          onSummarizationFallbackModelChange={handleSummarizationFallbackModelChange}
          onDefaultAgentChange={handleDefaultAgentChange}
        />
      )
    },
    {
      id: 'knowledge-base',
      category: 'models',
      searchText: 'knowledge base repository codebase semantic search indexing summaries custom prompt reindex cooldown',
      content: (
        <KnowledgeBaseSection
          settings={summarizationSettings}
          onSettingsChange={handleSummarizationChange}
          onReindexAll={handleReindexAll}
          isReindexing={isReindexing}
        />
      )
    },
    {
      id: 'general-configuration',
      category: 'automation',
      searchText: 'general configuration worker concurrency auto followup score threshold resolve merge conflicts ultrafix rating goal maximum cycles pause seconds',
      content: (
        <GeneralSettingsSection
          settings={{
            worker_concurrency: settings.worker_concurrency,
            auto_followup_score_threshold: settings.auto_followup_score_threshold,
            auto_resolve_merge_conflicts: settings.auto_resolve_merge_conflicts,
            ultrafix_rating_goal: settings.ultrafix_rating_goal,
            ultrafix_max_cycles: settings.ultrafix_max_cycles,
            ultrafix_pause_seconds: settings.ultrafix_pause_seconds
          }}
          onSettingChange={handleGeneralSettingChange}
          onBlur={triggerSettingsSave}
        />
      )
    },
    {
      id: 'github-user-whitelist',
      category: 'automation',
      searchText: 'GitHub user whitelist allowed users issue comment processing access trigger actors',
      content: (
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
      )
    },
    {
      id: 'primary-processing-labels',
      category: 'automation',
      searchText: 'primary processing labels issues auto processed state labels GitHub',
      content: (
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
      )
    },
    {
      id: 'pr-label',
      category: 'automation',
      searchText: 'pull request PR label follow-up comments monitor GitHub',
      content: (
        <PrLabelSection
          prLabel={prLabel}
          onLabelChange={(event) => setPrLabel(event.target.value)}
          onBlur={() => savePrLabelOnly(prLabel)}
        />
      )
    },
    {
      id: 'follow-up-keywords',
      category: 'automation',
      searchText: 'follow-up keywords trigger processing comments phrases',
      content: (
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
      )
    },
    {
      id: 'follow-up-ignore-keywords',
      category: 'automation',
      searchText: 'PR pull request follow-up ignore keywords prevent loops comments phrases',
      content: (
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
      )
    },
    {
      id: 'agent-tank',
      category: 'integrations',
      searchText: 'LLM usage tracking Agent Tank daemon URL rate limit Claude Antigravity Codex CLI connection',
      content: (
        <AgentTankSection
          settings={agentTankSettings}
          onChange={handleAgentTankChange}
          onBlur={triggerSettingsSave}
          isAvailable={agentTankAvailable}
          isCheckingStatus={agentTankCheckingStatus}
        />
      )
    },
    {
      id: 'agent-runtime-packages',
      category: 'integrations',
      searchText: 'agent runtime packages dependencies install catalog container image environment build',
      content: <AgentRuntimePackagesSection />
    },
    {
      id: 'visual-preview-uploads',
      category: 'integrations',
      searchText: 'visual preview upload screenshots videos GitHub login personal access token PAT credential authentication connect managed storage quota retention Plus originals',
      content: <><VisualPreviewAuthSection /><ManagedPreviewStorageSection /></>
    },
    ...(desktop ? [{
      id: 'desktop-voice',
      category: 'integrations' as const,
      searchText: 'desktop voice experimental microphone speech briefing enable disable',
      content: <DesktopVoiceSettingsSection />
    }, {
      id: 'desktop-notifications',
      category: 'notifications' as const,
      searchText: 'desktop native notifications operating system task started completed failed needs attention device test alert',
      content: <DesktopNotificationSettingsSection />
    }] : []),
    {
      id: 'mcp-server',
      category: 'integrations',
      searchText: 'MCP model context protocol AI assistant Claude Claude Code ChatGPT tools connection OAuth enable disable toggle server',
      content: <McpServerSection />
    },
    {
      id: 'personal-notifications',
      category: 'notifications',
      searchText: 'personal notifications browser web push inbox badge quiet hours timezone plans tasks reviews pull requests indexing system failures',
      content: <NotificationSettingsSection />
    }
  ];

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Anchored Header */}
      <div className="flex-shrink-0 px-6 py-4">
        <h2 className="text-gray-900 text-xl font-semibold">Settings</h2>
        {isDemoMode && (
          <p className="mt-1 text-xs text-amber-700">
            Demo mode is read-only. Settings can be inspected but not saved.
          </p>
        )}
      </div>

      <SettingsNavigation sections={settingsSections} isReadOnly={isDemoMode} />

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
            {saveStatus === 'warning' && globalError && (
              <span className="flex items-center gap-1.5 text-xs text-amber-700 font-mono">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500"></span>
                Saved with warning: {globalError}
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

const SettingsPage: React.FC = () => {
  useDocumentTitle('Settings');
  const user = useCurrentUser();
  const { isDemoMode } = useDemoMode();
  const desktop = useDesktop();

  if (userHasPermission(user, 'instance.manage_settings')) {
    return <AdminSettingsPage />;
  }

  return (
    <div className="flex h-full flex-col bg-white">
      <div className="flex-shrink-0 border-b border-gray-200 px-6 py-4">
        <h2 className="text-xl font-semibold text-gray-900">Settings</h2>
        <p className="mt-1 text-xs text-gray-500">Preferences for {user?.displayName || user?.username || 'your account'}.</p>
      </div>
      <fieldset
        disabled={isDemoMode}
        className={`flex-1 overflow-y-auto p-6 ${isDemoMode ? 'opacity-70' : ''}`}
      >
        <div className="mx-auto max-w-2xl">
          {desktop && <>
            <DesktopVoiceSettingsSection />
            <div className="my-6 border-t border-gray-200" />
            <DesktopNotificationSettingsSection />
            <div className="my-6 border-t border-gray-200" />
          </>}
          <NotificationSettingsSection />
        </div>
      </fieldset>
    </div>
  );
};

export default SettingsPage;
