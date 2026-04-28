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
import { parseLoadedData } from './parseLoadedData';
import { useListManagement } from './useListManagement';

// Debounce delay for prompt changes (in milliseconds)
const PROMPT_DEBOUNCE_DELAY = 800;
// Timeout for waiting on in-flight save operations (in milliseconds)
const SAVE_WAIT_TIMEOUT = 5000;

export function useSettingsState() {
  const [loading, setLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [globalError, setGlobalError] = useState<string | null>(null);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const summarizationSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const summarizationSaveInProgressRef = useRef<Promise<void> | null>(null);
  const pendingSummarizationSettingsRef = useRef<SummarizationSettings | null>(null);

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
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [summarizationSettings, setSummarizationSettings] = useState<SummarizationSettings>({
    enabled: false,
    agent_alias: ''
  });
  const [isReindexing, setIsReindexing] = useState(false);
  const [agentTankSettings, setAgentTankSettings] = useState<{ enabled: boolean; url: string }>({
    enabled: false,
    url: 'http://0.0.0.0:3456'
  });
  const [agentTankAvailable, setAgentTankAvailable] = useState<boolean | null>(null);
  const [agentTankCheckingStatus, setAgentTankCheckingStatus] = useState(false);

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
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    setSaveStatus('saving');
    setGlobalError(null);
    try {
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

  const lists = useListManagement(settings, prLabel, performAutoSave);

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
        lists.setWhitelist(parsed.whitelist);
        lists.setKeywords(parsed.keywords);
        lists.setIgnoreKeywords(parsed.ignoreKeywords);
        setPrLabel(parsed.prLabel);
        lists.setPrimaryLabels(parsed.primaryLabels);
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      if (summarizationSaveTimeoutRef.current) clearTimeout(summarizationSaveTimeoutRef.current);
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, []);

  const triggerAutoSave = useCallback(() => {
    performAutoSave({ settings, whitelist: lists.whitelist, prLabel, primaryLabels: lists.primaryLabels, keywords: lists.keywords, ignoreKeywords: lists.ignoreKeywords });
  }, [settings, lists.whitelist, prLabel, lists.primaryLabels, lists.keywords, lists.ignoreKeywords, performAutoSave]);

  const handleModelSelectionChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const newSettings = { ...settings, [e.target.name]: e.target.value };
    setSettings(newSettings);
    performAutoSave({ settings: newSettings, whitelist: lists.whitelist, prLabel, primaryLabels: lists.primaryLabels, keywords: lists.keywords, ignoreKeywords: lists.ignoreKeywords });
  }, [settings, lists.whitelist, prLabel, lists.primaryLabels, lists.keywords, lists.ignoreKeywords, performAutoSave]);

  const handleSummarizationChange = useCallback((newSettings: SummarizationSettings, isPromptChange = false) => {
    setSummarizationSettings(newSettings);
    if (summarizationSaveTimeoutRef.current) clearTimeout(summarizationSaveTimeoutRef.current);
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);

    const performSave = async (settingsToSave: SummarizationSettings) => {
      if (summarizationSaveInProgressRef.current) {
        try {
          await Promise.race([
            summarizationSaveInProgressRef.current,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Save operation timed out')), SAVE_WAIT_TIMEOUT))
          ]);
        } catch { /* Continue with save even if previous operation timed out */ }
      }
      if (pendingSummarizationSettingsRef.current && pendingSummarizationSettingsRef.current !== settingsToSave) return;
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

    pendingSummarizationSettingsRef.current = newSettings;
    if (isPromptChange) {
      summarizationSaveTimeoutRef.current = setTimeout(() => performSave(newSettings), PROMPT_DEBOUNCE_DELAY);
    } else {
      performSave(newSettings);
    }
  }, []);

  const handleSummarizationModelChange = useCallback((agentAlias: string) => {
    handleSummarizationChange({ ...summarizationSettings, agent_alias: agentAlias });
  }, [summarizationSettings, handleSummarizationChange]);

  const handleDefaultAgentChange = useCallback((agentAlias: string) => {
    const newSettings = { ...settings, default_agent_alias: agentAlias };
    setSettings(newSettings);
    performAutoSave({ settings: newSettings, whitelist: lists.whitelist, prLabel, primaryLabels: lists.primaryLabels, keywords: lists.keywords, ignoreKeywords: lists.ignoreKeywords });
  }, [settings, lists.whitelist, prLabel, lists.primaryLabels, lists.keywords, lists.ignoreKeywords, performAutoSave]);

  const handleAgentTankChange = useCallback((newSettings: { enabled: boolean; url: string }) => {
    setAgentTankSettings(newSettings);
    setAgentTankAvailable(null);
    updateAgentTankSettings(newSettings).catch(err => {
      console.error('Failed to save Agent Tank settings:', err);
    });
    if (newSettings.enabled) {
      setAgentTankCheckingStatus(true);
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

  const handleReindexAll = useCallback(async () => {
    setIsReindexing(true);
    setGlobalError(null);
    try {
      const result = await triggerReindexAll();
      if (result.success) {
        setSaveStatus('saved');
        if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
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
    loading, saveStatus, globalError, settings, prLabel, agents,
    summarizationSettings, isReindexing, agentTankSettings,
    agentTankAvailable, agentTankCheckingStatus,
    setSettings, setPrLabel,
    triggerAutoSave, handleModelSelectionChange,
    handleSummarizationChange, handleSummarizationModelChange,
    handleDefaultAgentChange, handleReindexAll, handleAgentTankChange,
    ...lists,
  };
}
