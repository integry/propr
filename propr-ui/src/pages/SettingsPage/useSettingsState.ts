import { useState, useEffect, useRef, useCallback } from 'react';
import {
  getSettings,
  updateSettings,
  getFollowupKeywords,
  updateFollowupKeywords,
  getFollowupIgnoreKeywords,
  updateFollowupIgnoreKeywords,
  getPrLabel,
  updatePrLabel,
  getPrimaryProcessingLabels,
  updatePrimaryProcessingLabels,
  getAgents,
  getSummarizationSettings,
  updateSummarizationSettings,
  triggerReindexAll,
  AgentConfig,
  SummarizationSettings
} from '../../api/proprApi';
import {
  getAgentTankSettings,
  updateAgentTankSettings,
  getAgentTankStatus
} from '../../api/revertApi';
import { Settings } from './types';

// Debounce delay for prompt changes (in milliseconds)
const PROMPT_DEBOUNCE_DELAY = 800;
// Timeout for waiting on in-flight save operations (in milliseconds)
const SAVE_WAIT_TIMEOUT = 5000;

// Helper function to determine default agent alias
function resolveDefaultAgentAlias(savedAlias: string | undefined, enabledAgents: AgentConfig[]): string {
  if (savedAlias) return savedAlias;
  if (enabledAgents.length === 0) return '';
  const claudeAgent = enabledAgents.find((a: AgentConfig) =>
    a.alias.toLowerCase() === 'claude' || a.alias.toLowerCase().includes('claude')
  );
  return claudeAgent ? claudeAgent.alias : enabledAgents[0].alias;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseLoadedData(results: any[]) {
  const [sData, kData, ignoreData, pLabelData, pLabelsData, aData, sumData, atData] = results;
  const settingsData = sData as {
    worker_concurrency?: string; analysis_model_fast?: string;
    planner_context_model?: string; planner_generation_model?: string;
    default_agent_alias?: string; github_user_whitelist?: string[];
    auto_followup_score_threshold?: number; auto_resolve_merge_conflicts?: boolean;
    pr_review_model?: string; ultrafix_rating_goal?: number;
    ultrafix_max_cycles?: number; ultrafix_pause_seconds?: number;
  };
  const agentsList = (aData as { agents?: AgentConfig[] }).agents || [];
  const enabledAgents = agentsList.filter((a: AgentConfig) => a.enabled);
  const whitelistRaw = settingsData.github_user_whitelist || [];
  const summarizationData = sumData as SummarizationSettings;
  return {
    settings: {
      worker_concurrency: settingsData.worker_concurrency || '',
      analysis_model_fast: settingsData.analysis_model_fast || '',
      planner_context_model: settingsData.planner_context_model || '',
      planner_generation_model: settingsData.planner_generation_model || '',
      default_agent_alias: resolveDefaultAgentAlias(settingsData.default_agent_alias, enabledAgents),
      auto_followup_score_threshold: settingsData.auto_followup_score_threshold ?? 4,
      auto_resolve_merge_conflicts: settingsData.auto_resolve_merge_conflicts ?? false,
      pr_review_model: settingsData.pr_review_model || '',
      ultrafix_rating_goal: settingsData.ultrafix_rating_goal ?? 7,
      ultrafix_max_cycles: settingsData.ultrafix_max_cycles ?? 5,
      ultrafix_pause_seconds: settingsData.ultrafix_pause_seconds ?? 60,
    },
    whitelist: Array.isArray(whitelistRaw) ? whitelistRaw : [],
    keywords: (kData as { followup_keywords?: string[] }).followup_keywords || [],
    ignoreKeywords: (ignoreData as { followup_ignore_keywords?: string[] }).followup_ignore_keywords || [],
    prLabel: (pLabelData as { pr_label?: string }).pr_label || 'propr',
    primaryLabels: (pLabelsData as { primary_processing_labels?: string[] }).primary_processing_labels || ['AI'],
    agents: agentsList,
    summarizationSettings: {
      enabled: summarizationData.enabled || false,
      agent_alias: summarizationData.agent_alias || '',
      custom_prompt: summarizationData.custom_prompt,
      default_prompt: summarizationData.default_prompt,
    },
    agentTankSettings: { enabled: atData.enabled || false, url: atData.url || 'http://0.0.0.0:3456' },
  };
}

export function useSettingsState() {
  // Global state
  const [loading, setLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [globalError, setGlobalError] = useState<string | null>(null);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const summarizationSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Track in-flight save operation to prevent 409 errors
  const summarizationSaveInProgressRef = useRef<Promise<void> | null>(null);
  const pendingSummarizationSettingsRef = useRef<SummarizationSettings | null>(null);

  // Data state
  const [settings, setSettings] = useState<Settings>({
    worker_concurrency: '',
    analysis_model_fast: '',
    planner_context_model: '',
    planner_generation_model: '',
    default_agent_alias: '',
    auto_followup_score_threshold: 4,
    auto_resolve_merge_conflicts: false,
    pr_review_model: '',
    ultrafix_rating_goal: 7,
    ultrafix_max_cycles: 5,
    ultrafix_pause_seconds: 60
  });
  const [prLabel, setPrLabel] = useState('');

  // Lists state
  const [whitelist, setWhitelist] = useState<string[]>([]);
  const [newWhitelistItem, setNewWhitelistItem] = useState('');

  const [primaryLabels, setPrimaryLabels] = useState<string[]>([]);
  const [newPrimaryLabel, setNewPrimaryLabel] = useState('');

  const [keywords, setKeywords] = useState<string[]>([]);
  const [newKeyword, setNewKeyword] = useState('');

  const [ignoreKeywords, setIgnoreKeywords] = useState<string[]>([]);
  const [newIgnoreKeyword, setNewIgnoreKeyword] = useState('');

  const [agents, setAgents] = useState<AgentConfig[]>([]);

  const [summarizationSettings, setSummarizationSettings] = useState<SummarizationSettings>({
    enabled: false,
    agent_alias: ''
  });

  const [isReindexing, setIsReindexing] = useState(false);

  // Agent Tank state
  const [agentTankSettings, setAgentTankSettings] = useState<{ enabled: boolean; url: string }>({
    enabled: false,
    url: 'http://0.0.0.0:3456'
  });
  const [agentTankAvailable, setAgentTankAvailable] = useState<boolean | null>(null);
  const [agentTankCheckingStatus, setAgentTankCheckingStatus] = useState(false);

  // Load all data with Promise.all
  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      try {
        const results = await Promise.all([
          getSettings(), getFollowupKeywords(), getFollowupIgnoreKeywords(),
          getPrLabel(), getPrimaryProcessingLabels(), getAgents(),
          getSummarizationSettings(),
          getAgentTankSettings().catch(() => ({ enabled: false, url: 'http://0.0.0.0:3456' }))
        ]);
        const parsed = parseLoadedData(results);
        setSettings(parsed.settings);
        setWhitelist(parsed.whitelist);
        setKeywords(parsed.keywords);
        setIgnoreKeywords(parsed.ignoreKeywords);
        setPrLabel(parsed.prLabel);
        setPrimaryLabels(parsed.primaryLabels);
        setAgents(parsed.agents);
        setSummarizationSettings(parsed.summarizationSettings);
        setAgentTankSettings(parsed.agentTankSettings);
        if (parsed.agentTankSettings.enabled) {
          setAgentTankCheckingStatus(true);
          getAgentTankStatus()
            .then(status => setAgentTankAvailable(status.available))
            .catch(() => setAgentTankAvailable(false))
            .finally(() => setAgentTankCheckingStatus(false));
        }
      } catch (err) {
        setGlobalError((err as Error).message || 'Failed to load settings');
      } finally {
        setLoading(false);
      }
    };
    loadData();
  }, []);

  // Cleanup debounce timeouts on unmount
  useEffect(() => {
    return () => {
      if (summarizationSaveTimeoutRef.current) {
        clearTimeout(summarizationSaveTimeoutRef.current);
      }
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  // Auto-save function
  const performAutoSave = useCallback(async (options: {
    settings: Settings;
    whitelist: string[];
    prLabel: string;
    primaryLabels: string[];
    keywords: string[];
    ignoreKeywords: string[];
  }) => {
    const { settings: settingsToSave, whitelist: whitelistToSave, prLabel: prLabelToSave, primaryLabels: primaryLabelsToSave, keywords: keywordsToSave, ignoreKeywords: ignoreKeywordsToSave } = options;
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
          planner_context_model: settingsToSave.planner_context_model,
          planner_generation_model: settingsToSave.planner_generation_model,
          default_agent_alias: settingsToSave.default_agent_alias,
          auto_followup_score_threshold: settingsToSave.auto_followup_score_threshold,
          auto_resolve_merge_conflicts: settingsToSave.auto_resolve_merge_conflicts,
          pr_review_model: settingsToSave.pr_review_model,
          ultrafix_rating_goal: settingsToSave.ultrafix_rating_goal,
          ultrafix_max_cycles: settingsToSave.ultrafix_max_cycles,
          ultrafix_pause_seconds: settingsToSave.ultrafix_pause_seconds
        }),
        updatePrLabel(prLabelToSave.trim()),
        updatePrimaryProcessingLabels(primaryLabelsToSave),
        updateFollowupKeywords(keywordsToSave),
        updateFollowupIgnoreKeywords(ignoreKeywordsToSave)
      ]);

      setSaveStatus('saved');
      saveTimeoutRef.current = setTimeout(() => setSaveStatus('idle'), 3000);
    } catch (err) {
      setSaveStatus('error');
      setGlobalError((err as Error).message || 'Failed to save settings');
    }
  }, []);

  // Trigger auto-save (called on blur and list changes)
  const triggerAutoSave = useCallback(() => {
    performAutoSave({ settings, whitelist, prLabel, primaryLabels, keywords, ignoreKeywords });
  }, [settings, whitelist, prLabel, primaryLabels, keywords, ignoreKeywords, performAutoSave]);

  // Handle model selection changes (immediate save)
  const handleModelSelectionChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const newSettings = { ...settings, [e.target.name]: e.target.value };
    setSettings(newSettings);
    performAutoSave({ settings: newSettings, whitelist, prLabel, primaryLabels, keywords, ignoreKeywords });
  }, [settings, whitelist, prLabel, primaryLabels, keywords, ignoreKeywords, performAutoSave]);

  // List management functions that trigger auto-save
  const addWhitelistItem = useCallback(() => {
    if (!newWhitelistItem.trim() || whitelist.includes(newWhitelistItem.trim())) return;
    const newList = [...whitelist, newWhitelistItem.trim()];
    setWhitelist(newList);
    setNewWhitelistItem('');
    performAutoSave({ settings, whitelist: newList, prLabel, primaryLabels, keywords, ignoreKeywords });
  }, [newWhitelistItem, whitelist, settings, prLabel, primaryLabels, keywords, ignoreKeywords, performAutoSave]);

  const removeWhitelistItem = useCallback((item: string) => {
    const newList = whitelist.filter(i => i !== item);
    setWhitelist(newList);
    performAutoSave({ settings, whitelist: newList, prLabel, primaryLabels, keywords, ignoreKeywords });
  }, [whitelist, settings, prLabel, primaryLabels, keywords, ignoreKeywords, performAutoSave]);

  const addPrimaryLabel = useCallback(() => {
    if (!newPrimaryLabel.trim() || primaryLabels.includes(newPrimaryLabel.trim())) return;
    const newList = [...primaryLabels, newPrimaryLabel.trim()];
    setPrimaryLabels(newList);
    setNewPrimaryLabel('');
    performAutoSave({ settings, whitelist, prLabel, primaryLabels: newList, keywords, ignoreKeywords });
  }, [newPrimaryLabel, primaryLabels, settings, whitelist, prLabel, keywords, ignoreKeywords, performAutoSave]);

  const removePrimaryLabel = useCallback((item: string) => {
    const newList = primaryLabels.filter(i => i !== item);
    setPrimaryLabels(newList);
    performAutoSave({ settings, whitelist, prLabel, primaryLabels: newList, keywords, ignoreKeywords });
  }, [primaryLabels, settings, whitelist, prLabel, keywords, ignoreKeywords, performAutoSave]);

  const addKeyword = useCallback(() => {
    if (!newKeyword.trim() || keywords.includes(newKeyword.trim())) return;
    const newList = [...keywords, newKeyword.trim()];
    setKeywords(newList);
    setNewKeyword('');
    performAutoSave({ settings, whitelist, prLabel, primaryLabels, keywords: newList, ignoreKeywords });
  }, [newKeyword, keywords, settings, whitelist, prLabel, primaryLabels, ignoreKeywords, performAutoSave]);

  const removeKeyword = useCallback((item: string) => {
    const newList = keywords.filter(i => i !== item);
    setKeywords(newList);
    performAutoSave({ settings, whitelist, prLabel, primaryLabels, keywords: newList, ignoreKeywords });
  }, [keywords, settings, whitelist, prLabel, primaryLabels, ignoreKeywords, performAutoSave]);

  const addIgnoreKeyword = useCallback(() => {
    if (!newIgnoreKeyword.trim() || ignoreKeywords.includes(newIgnoreKeyword.trim())) return;
    const newList = [...ignoreKeywords, newIgnoreKeyword.trim()];
    setIgnoreKeywords(newList);
    setNewIgnoreKeyword('');
    performAutoSave({ settings, whitelist, prLabel, primaryLabels, keywords, ignoreKeywords: newList });
  }, [newIgnoreKeyword, ignoreKeywords, settings, whitelist, prLabel, primaryLabels, keywords, performAutoSave]);

  const removeIgnoreKeyword = useCallback((item: string) => {
    const newList = ignoreKeywords.filter(i => i !== item);
    setIgnoreKeywords(newList);
    performAutoSave({ settings, whitelist, prLabel, primaryLabels, keywords, ignoreKeywords: newList });
  }, [ignoreKeywords, settings, whitelist, prLabel, primaryLabels, keywords, performAutoSave]);

  // Handle summarization settings changes (separate save endpoint)
  const handleSummarizationChange = useCallback((newSettings: SummarizationSettings, isPromptChange = false) => {
    setSummarizationSettings(newSettings);

    // Clear any pending debounced save
    if (summarizationSaveTimeoutRef.current) {
      clearTimeout(summarizationSaveTimeoutRef.current);
    }

    // Clear any pending status timeout
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    const performSave = async (settingsToSave: SummarizationSettings) => {
      // Wait for any in-flight save operation to complete (with timeout)
      if (summarizationSaveInProgressRef.current) {
        try {
          await Promise.race([
            summarizationSaveInProgressRef.current,
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Save operation timed out')), SAVE_WAIT_TIMEOUT)
            )
          ]);
        } catch {
          // Continue with save even if previous operation timed out
        }
      }

      // Check if there's a newer pending save - if so, skip this one
      if (pendingSummarizationSettingsRef.current &&
          pendingSummarizationSettingsRef.current !== settingsToSave) {
        return;
      }

      setSaveStatus('saving');
      setGlobalError(null);

      const savePromise = (async () => {
        try {
          await updateSummarizationSettings(settingsToSave);
          setSaveStatus('saved');
          saveTimeoutRef.current = setTimeout(() => setSaveStatus('idle'), 3000);
        } catch (err) {
          setSaveStatus('error');
          setGlobalError((err as Error).message || 'Failed to save summarization settings');
        } finally {
          summarizationSaveInProgressRef.current = null;
          pendingSummarizationSettingsRef.current = null;
        }
      })();

      summarizationSaveInProgressRef.current = savePromise;
      await savePromise;
    };

    // Store the pending settings so we can skip outdated saves
    pendingSummarizationSettingsRef.current = newSettings;

    if (isPromptChange) {
      // Debounce prompt changes to avoid too many requests while typing
      summarizationSaveTimeoutRef.current = setTimeout(() => performSave(newSettings), PROMPT_DEBOUNCE_DELAY);
    } else {
      // Immediate save for toggle and dropdown changes
      performSave(newSettings);
    }
  }, []);

  // Handle summarization model change from AI Model Selection section
  const handleSummarizationModelChange = useCallback((agentAlias: string) => {
    const newSettings = {
      ...summarizationSettings,
      agent_alias: agentAlias
    };
    handleSummarizationChange(newSettings);
  }, [summarizationSettings, handleSummarizationChange]);

  // Handle default agent change from AI Model Selection section
  const handleDefaultAgentChange = useCallback((agentAlias: string) => {
    const newSettings = { ...settings, default_agent_alias: agentAlias };
    setSettings(newSettings);
    performAutoSave({ settings: newSettings, whitelist, prLabel, primaryLabels, keywords, ignoreKeywords });
  }, [settings, whitelist, prLabel, primaryLabels, keywords, ignoreKeywords, performAutoSave]);

  // Handle Agent Tank settings changes
  const handleAgentTankChange = useCallback((newSettings: { enabled: boolean; url: string }) => {
    setAgentTankSettings(newSettings);
    setAgentTankAvailable(null);

    // Save to backend
    updateAgentTankSettings(newSettings).catch(err => {
      console.error('Failed to save Agent Tank settings:', err);
    });

    // Check status if enabled
    if (newSettings.enabled) {
      setAgentTankCheckingStatus(true);
      // Small delay to let settings propagate
      setTimeout(() => {
        getAgentTankStatus()
          .then(status => setAgentTankAvailable(status.available))
          .catch(() => setAgentTankAvailable(false))
          .finally(() => setAgentTankCheckingStatus(false));
      }, 500);
    } else {
      setAgentTankCheckingStatus(false);
    }
  }, []);

  // Handle manual reindex trigger
  const handleReindexAll = useCallback(async () => {
    setIsReindexing(true);
    setGlobalError(null);
    try {
      const result = await triggerReindexAll();
      if (result.success) {
        setSaveStatus('saved');
        if (saveTimeoutRef.current) {
          clearTimeout(saveTimeoutRef.current);
        }
        saveTimeoutRef.current = setTimeout(() => setSaveStatus('idle'), 3000);
      }
    } catch (err) {
      setGlobalError((err as Error).message || 'Failed to trigger reindexing');
      setSaveStatus('error');
    } finally {
      setIsReindexing(false);
    }
  }, []);

  return {
    // State
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
    agentTankSettings,
    agentTankAvailable,
    agentTankCheckingStatus,
    // Setters
    setSettings,
    setPrLabel,
    setNewWhitelistItem,
    setNewPrimaryLabel,
    setNewKeyword,
    setNewIgnoreKeyword,
    // Actions
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
    handleReindexAll,
    handleAgentTankChange
  };
}
