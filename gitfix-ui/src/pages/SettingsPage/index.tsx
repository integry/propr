import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  getSettings,
  updateSettings,
  getFollowupKeywords,
  updateFollowupKeywords,
  getPrLabel,
  updatePrLabel,
  getPrimaryProcessingLabels,
  updatePrimaryProcessingLabels,
  getAgents,
  getSummarizationSettings,
  updateSummarizationSettings,
  AgentConfig,
  SummarizationSettings
} from '../../api/gitfixApi';
import { Settings } from './types';
import GeneralSettingsSection from './GeneralSettingsSection';
import PrLabelSection from './PrLabelSection';
import TagListSection from './TagListSection';
import KnowledgeBaseSection from './KnowledgeBaseSection';

const SettingsPage: React.FC = () => {
  // Global state
  const [loading, setLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [globalError, setGlobalError] = useState<string | null>(null);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Data state
  const [settings, setSettings] = useState<Settings>({
    worker_concurrency: '',
    analysis_model_fast: '',
    analysis_model_advanced: ''
  });
  const [prLabel, setPrLabel] = useState('');

  // Lists state
  const [whitelist, setWhitelist] = useState<string[]>([]);
  const [newWhitelistItem, setNewWhitelistItem] = useState('');

  const [primaryLabels, setPrimaryLabels] = useState<string[]>([]);
  const [newPrimaryLabel, setNewPrimaryLabel] = useState('');

  const [keywords, setKeywords] = useState<string[]>([]);
  const [newKeyword, setNewKeyword] = useState('');

  const [agents, setAgents] = useState<AgentConfig[]>([]);

  const [summarizationSettings, setSummarizationSettings] = useState<SummarizationSettings>({
    enabled: false,
    agent_alias: ''
  });

  // Load all data with Promise.all
  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      try {
        const [sData, kData, pLabelData, pLabelsData, aData, sumData] = await Promise.all([
          getSettings(),
          getFollowupKeywords(),
          getPrLabel(),
          getPrimaryProcessingLabels(),
          getAgents(),
          getSummarizationSettings()
        ]);

        // Type assertions for API responses
        const settingsData = sData as {
          worker_concurrency?: string;
          analysis_model_fast?: string;
          analysis_model_advanced?: string;
          github_user_whitelist?: string[];
        };
        const keywordsData = kData as { followup_keywords?: string[] };
        const prLabelDataTyped = pLabelData as { pr_label?: string };
        const primaryLabelsData = pLabelsData as { primary_processing_labels?: string[] };
        const agentsData = aData as { agents?: AgentConfig[] };
        const summarizationData = sumData as SummarizationSettings;

        // Parse Settings
        setSettings({
          worker_concurrency: settingsData.worker_concurrency || '',
          analysis_model_fast: settingsData.analysis_model_fast || '',
          analysis_model_advanced: settingsData.analysis_model_advanced || ''
        });

        // Parse Whitelist
        const whitelistRaw = settingsData.github_user_whitelist || [];
        setWhitelist(Array.isArray(whitelistRaw) ? whitelistRaw : []);

        setKeywords(keywordsData.followup_keywords || []);
        setPrLabel(prLabelDataTyped.pr_label || 'gitfix');
        setPrimaryLabels(primaryLabelsData.primary_processing_labels || ['AI']);
        setAgents(agentsData.agents || []);
        setSummarizationSettings({
          enabled: summarizationData.enabled || false,
          agent_alias: summarizationData.agent_alias || '',
          custom_prompt: summarizationData.custom_prompt,
          default_prompt: summarizationData.default_prompt
        });
      } catch (err) {
        setGlobalError((err as Error).message || 'Failed to load settings');
      } finally {
        setLoading(false);
      }
    };
    loadData();
  }, []);

  // Auto-save function
  const performAutoSave = useCallback(async (
    settingsToSave: Settings,
    whitelistToSave: string[],
    prLabelToSave: string,
    primaryLabelsToSave: string[],
    keywordsToSave: string[]
  ) => {
    // Clear any pending save timeout
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    setSaveStatus('saving');
    setGlobalError(null);

    try {
      // Validate
      const concurrency = parseInt(settingsToSave.worker_concurrency);
      if (settingsToSave.worker_concurrency && isNaN(concurrency)) {
        throw new Error('Worker concurrency must be a number');
      }
      if (!prLabelToSave.trim()) {
        throw new Error('PR Label cannot be empty');
      }
      if (primaryLabelsToSave.length === 0) {
        throw new Error('At least one primary processing label is required');
      }

      await Promise.all([
        updateSettings({
          worker_concurrency: settingsToSave.worker_concurrency ? concurrency : undefined,
          github_user_whitelist: whitelistToSave,
          analysis_model_fast: settingsToSave.analysis_model_fast,
          analysis_model_advanced: settingsToSave.analysis_model_advanced
        }),
        updatePrLabel(prLabelToSave.trim()),
        updatePrimaryProcessingLabels(primaryLabelsToSave),
        updateFollowupKeywords(keywordsToSave)
      ]);

      setSaveStatus('saved');

      // Clear "Saved" status after 3s
      saveTimeoutRef.current = setTimeout(() => setSaveStatus('idle'), 3000);
    } catch (err) {
      setSaveStatus('error');
      setGlobalError((err as Error).message || 'Failed to save settings');
    }
  }, []);

  // Trigger auto-save (called on blur and list changes)
  const triggerAutoSave = useCallback(() => {
    performAutoSave(settings, whitelist, prLabel, primaryLabels, keywords);
  }, [settings, whitelist, prLabel, primaryLabels, keywords, performAutoSave]);

  // List management functions that trigger auto-save
  const addWhitelistItem = () => {
    if (!newWhitelistItem.trim() || whitelist.includes(newWhitelistItem.trim())) return;
    const newList = [...whitelist, newWhitelistItem.trim()];
    setWhitelist(newList);
    setNewWhitelistItem('');
    performAutoSave(settings, newList, prLabel, primaryLabels, keywords);
  };

  const removeWhitelistItem = (item: string) => {
    const newList = whitelist.filter(i => i !== item);
    setWhitelist(newList);
    performAutoSave(settings, newList, prLabel, primaryLabels, keywords);
  };

  const addPrimaryLabel = () => {
    if (!newPrimaryLabel.trim() || primaryLabels.includes(newPrimaryLabel.trim())) return;
    const newList = [...primaryLabels, newPrimaryLabel.trim()];
    setPrimaryLabels(newList);
    setNewPrimaryLabel('');
    performAutoSave(settings, whitelist, prLabel, newList, keywords);
  };

  const removePrimaryLabel = (item: string) => {
    const newList = primaryLabels.filter(i => i !== item);
    setPrimaryLabels(newList);
    performAutoSave(settings, whitelist, prLabel, newList, keywords);
  };

  const addKeyword = () => {
    if (!newKeyword.trim() || keywords.includes(newKeyword.trim())) return;
    const newList = [...keywords, newKeyword.trim()];
    setKeywords(newList);
    setNewKeyword('');
    performAutoSave(settings, whitelist, prLabel, primaryLabels, newList);
  };

  const removeKeyword = (item: string) => {
    const newList = keywords.filter(i => i !== item);
    setKeywords(newList);
    performAutoSave(settings, whitelist, prLabel, primaryLabels, newList);
  };

  // Handle summarization settings changes (separate save endpoint)
  const handleSummarizationChange = async (newSettings: SummarizationSettings) => {
    setSummarizationSettings(newSettings);

    // Clear any pending save timeout
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    setSaveStatus('saving');
    setGlobalError(null);

    try {
      await updateSummarizationSettings(newSettings);
      setSaveStatus('saved');
      saveTimeoutRef.current = setTimeout(() => setSaveStatus('idle'), 3000);
    } catch (err) {
      setSaveStatus('error');
      setGlobalError((err as Error).message || 'Failed to save summarization settings');
    }
  };

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
          <GeneralSettingsSection
            settings={settings}
            agents={agents}
            onSettingChange={(e) =>
              setSettings(prev => ({ ...prev, [e.target.name]: e.target.value }))
            }
            onBlur={triggerAutoSave}
          />

          <KnowledgeBaseSection
            settings={summarizationSettings}
            agents={agents}
            onSettingsChange={handleSummarizationChange}
          />

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
        </div>

        {/* Right Column */}
        <div className="space-y-6">
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
            placeholder="e.g., GITFIX"
            emptyMessage="No keywords configured."
            showEmptyIcon={true}
          />
        </div>
      </div>
    </div>
  );
};

export default SettingsPage;
