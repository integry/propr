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
import type { TriggerReindexAllResponse } from '../../api/proprApi';
import { isCommittedConfigWriteError } from '../../api/apiClient';

// Debounce delay for prompt changes (in milliseconds)
const PROMPT_DEBOUNCE_DELAY = 800;
// Timeout for waiting on in-flight save operations (in milliseconds)
const SAVE_WAIT_TIMEOUT = 5000;

function buildReindexAllSkipMessage(result: TriggerReindexAllResponse): string {
  const skippedCooldown = result.repositoriesSkippedCooldown ?? 0;
  const skippedAlreadyQueued = result.repositoriesSkippedAlreadyQueued ?? 0;
  const failedClone = result.repositoriesFailedClone ?? 0;
  const skipped = [
    skippedCooldown > 0 ? `${skippedCooldown} in cooldown` : '',
    skippedAlreadyQueued > 0 ? `${skippedAlreadyQueued} already queued` : '',
    failedClone > 0 ? `${failedClone} failed clone` : ''
  ].filter(Boolean).join(', ');
  return skipped
    ? `No repositories were queued for reindexing (${skipped}).`
    : 'No repositories were queued for reindexing.';
}

export function useSettingsState() {
  const [loading, setLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'warning' | 'error'>('idle');
  const [globalError, setGlobalError] = useState<string | null>(null);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const summarizationSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const summarizationSaveInProgressRef = useRef<Promise<void> | null>(null);
  const pendingSummarizationSettingsRef = useRef<SummarizationSettings | null>(null);
  const reloadConfigurationRef = useRef<() => Promise<void>>(async () => {
    throw new Error('Configuration reload is not ready');
  });
  const configurationReloadRequiredRef = useRef(false);

  const [settings, setSettings] = useState<Settings>({
    worker_concurrency: '',
    analysis_model_fast: '',
    planner_context_model: '',
    planner_generation_model: '',
    default_agent_alias: '',
    auto_followup_score_threshold: 4,
    auto_resolve_merge_conflicts: false,
    model_reasoning_level: '',
    pr_review_model: '',
    pr_review_prompt: '',
    pr_review_context_enabled: true,
    pr_review_context_model: '',
    pr_review_max_context_tokens: 0,
    ultrafix_rating_goal: 7,
    ultrafix_max_cycles: 5,
    ultrafix_pause_seconds: 60
  });
  const [prLabel, setPrLabel] = useState('');
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [summarizationSettings, setSummarizationSettings] = useState<SummarizationSettings>({
    enabled: false,
    agent_alias: '',
    fallback_agent_alias: ''
  });
  const [isReindexing, setIsReindexing] = useState(false);
  const [agentTankSettings, setAgentTankSettings] = useState<{ enabled: boolean; url: string }>({
    enabled: false,
    url: 'http://0.0.0.0:3456'
  });
  const [agentTankAvailable, setAgentTankAvailable] = useState<boolean | null>(null);
  const [agentTankCheckingStatus, setAgentTankCheckingStatus] = useState(false);

  const beginSave = useCallback((): boolean => {
    if (configurationReloadRequiredRef.current) {
      setSaveStatus('error');
      setGlobalError('Reload the current configuration before saving again.');
      return false;
    }
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    setSaveStatus('saving');
    setGlobalError(null);
    return true;
  }, []);

  const completeSave = useCallback((warnings: string[] = []) => {
    if (warnings.length > 0) {
      setSaveStatus('warning');
      setGlobalError(warnings.join(' '));
      return;
    }
    setSaveStatus('saved');
    saveTimeoutRef.current = setTimeout(() => setSaveStatus('idle'), 3000);
  }, []);

  const failSave = useCallback((err: unknown, fallbackMessage: string) => {
    setSaveStatus('error');
    setGlobalError((err as Error).message || fallbackMessage);
  }, []);

  const reconcileSaveFailure = useCallback(async (err: unknown): Promise<unknown> => {
    if (!isCommittedConfigWriteError(err)) return err;
    try {
      // Keep this save pending until every configuration field has been
      // replaced with the authoritative persisted state.
      await reloadConfigurationRef.current();
      return err;
    } catch (refreshError) {
      configurationReloadRequiredRef.current = true;
      const refreshMessage = refreshError instanceof Error ? refreshError.message : String(refreshError);
      return new Error(`${err.message} Automatic refresh failed (${refreshMessage}). Reload this page before editing configuration again.`);
    }
  }, []);

  const saveSettingsOnly = useCallback(async (settingsToSave: Settings) => {
    if (!beginSave()) return;
    try {
      const concurrency = parseInt(settingsToSave.worker_concurrency);
      if (settingsToSave.worker_concurrency && isNaN(concurrency)) {
        throw new Error('Worker concurrency must be a number');
      }
      const result = await updateSettings({
        worker_concurrency: settingsToSave.worker_concurrency ? concurrency : undefined,
        analysis_model_fast: settingsToSave.analysis_model_fast,
        planner_context_model: settingsToSave.planner_context_model,
        planner_generation_model: settingsToSave.planner_generation_model,
        default_agent_alias: settingsToSave.default_agent_alias,
        auto_followup_score_threshold: settingsToSave.auto_followup_score_threshold,
        auto_resolve_merge_conflicts: settingsToSave.auto_resolve_merge_conflicts,
        model_reasoning_level: settingsToSave.model_reasoning_level,
        pr_review_model: settingsToSave.pr_review_model,
        pr_review_prompt: settingsToSave.pr_review_prompt,
        pr_review_context_enabled: settingsToSave.pr_review_context_enabled,
        pr_review_context_model: settingsToSave.pr_review_context_model,
        pr_review_max_context_tokens: settingsToSave.pr_review_max_context_tokens,
        ultrafix_rating_goal: settingsToSave.ultrafix_rating_goal,
        ultrafix_max_cycles: settingsToSave.ultrafix_max_cycles,
        ultrafix_pause_seconds: settingsToSave.ultrafix_pause_seconds
      });
      completeSave(result.warnings);
    } catch (err) {
      failSave(await reconcileSaveFailure(err), 'Failed to save settings');
    }
  }, [beginSave, completeSave, failSave, reconcileSaveFailure]);

  const saveWhitelistOnly = useCallback(async (whitelistToSave: string[]) => {
    if (!beginSave()) return;
    try {
      await updateSettings({ github_user_whitelist: whitelistToSave });
      completeSave();
    } catch (err) {
      failSave(await reconcileSaveFailure(err), 'Failed to save whitelist');
    }
  }, [beginSave, completeSave, failSave, reconcileSaveFailure]);

  const savePrLabelOnly = useCallback(async (prLabelToSave: string) => {
    if (!beginSave()) return;
    try {
      if (!prLabelToSave.trim()) {
        throw new Error('PR Label cannot be empty');
      }
      await updatePrLabel(prLabelToSave.trim());
      completeSave();
    } catch (err) {
      failSave(await reconcileSaveFailure(err), 'Failed to save PR label');
    }
  }, [beginSave, completeSave, failSave, reconcileSaveFailure]);

  const savePrimaryLabelsOnly = useCallback(async (primaryLabelsToSave: string[]) => {
    if (!beginSave()) return;
    try {
      if (primaryLabelsToSave.length === 0) {
        throw new Error('At least one primary processing label is required');
      }
      await updatePrimaryProcessingLabels(primaryLabelsToSave);
      completeSave();
    } catch (err) {
      failSave(await reconcileSaveFailure(err), 'Failed to save primary processing labels');
    }
  }, [beginSave, completeSave, failSave, reconcileSaveFailure]);

  const saveKeywordsOnly = useCallback(async (keywordsToSave: string[]) => {
    if (!beginSave()) return;
    try {
      await updateFollowupKeywords(keywordsToSave);
      completeSave();
    } catch (err) {
      failSave(await reconcileSaveFailure(err), 'Failed to save follow-up keywords');
    }
  }, [beginSave, completeSave, failSave, reconcileSaveFailure]);

  const saveIgnoreKeywordsOnly = useCallback(async (ignoreKeywordsToSave: string[]) => {
    if (!beginSave()) return;
    try {
      await updateFollowupIgnoreKeywords(ignoreKeywordsToSave);
      completeSave();
    } catch (err) {
      failSave(await reconcileSaveFailure(err), 'Failed to save follow-up ignore keywords');
    }
  }, [beginSave, completeSave, failSave, reconcileSaveFailure]);

  const lists = useListManagement(
    saveWhitelistOnly,
    savePrimaryLabelsOnly,
    saveKeywordsOnly,
    saveIgnoreKeywordsOnly
  );

  const { setWhitelist, setKeywords, setIgnoreKeywords, setPrimaryLabels } = lists;
  const loadData = useCallback(async (requireCompleteConfiguration = false): Promise<void> => {
    setLoading(true);
    try {
      const agentTankSettingsRequest = requireCompleteConfiguration
        ? getAgentTankSettings()
        : getAgentTankSettings().catch(() => ({ enabled: false, url: 'http://0.0.0.0:3456' }));
      const results = await Promise.all([
        getSettings(), getFollowupKeywords(), getFollowupIgnoreKeywords(),
        getPrLabel(), getPrimaryProcessingLabels(), getAgents(),
        getSummarizationSettings(),
        agentTankSettingsRequest
      ]);
      const parsed = parseLoadedData(results);
      configurationReloadRequiredRef.current = false;
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
      throw err;
    } finally {
      setLoading(false);
    }
  }, [setIgnoreKeywords, setKeywords, setPrimaryLabels, setWhitelist]);
  reloadConfigurationRef.current = () => loadData(true);

  // Load all configuration once, and reuse the same authoritative refresh
  // after a server reports that a write committed with a warning.
  useEffect(() => {
    void loadData().catch(() => undefined);
  }, [loadData]);

  useEffect(() => {
    return () => {
      if (summarizationSaveTimeoutRef.current) clearTimeout(summarizationSaveTimeoutRef.current);
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, []);

  const triggerSettingsSave = useCallback(() => {
    saveSettingsOnly(settings);
  }, [settings, saveSettingsOnly]);

  const handleModelSelectionChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const newSettings = { ...settings, [e.target.name]: e.target.value };
    setSettings(newSettings);
    saveSettingsOnly(newSettings);
  }, [settings, saveSettingsOnly]);

  const handleReviewContextEnabledChange = useCallback((enabled: boolean) => {
    const newSettings = { ...settings, pr_review_context_enabled: enabled };
    setSettings(newSettings);
    saveSettingsOnly(newSettings);
  }, [settings, saveSettingsOnly]);

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
      if (!beginSave()) {
        pendingSummarizationSettingsRef.current = null;
        return;
      }
      const savePromise = (async () => {
        try {
          await updateSummarizationSettings(settingsToSave);
          setSaveStatus('saved');
          saveTimeoutRef.current = setTimeout(() => setSaveStatus('idle'), 3000);
        } catch (err) {
          const reconciledError = await reconcileSaveFailure(err);
          setSaveStatus('error');
          setGlobalError((reconciledError as Error).message || 'Failed to save summarization settings');
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
  }, [beginSave, reconcileSaveFailure]);

  const handleSummarizationModelChange = useCallback((agentAlias: string) => {
    handleSummarizationChange({ ...summarizationSettings, agent_alias: agentAlias });
  }, [summarizationSettings, handleSummarizationChange]);

  const handleSummarizationFallbackModelChange = useCallback((agentAlias: string) => {
    handleSummarizationChange({ ...summarizationSettings, fallback_agent_alias: agentAlias });
  }, [summarizationSettings, handleSummarizationChange]);

  const handleDefaultAgentChange = useCallback((agentAlias: string) => {
    const newSettings = { ...settings, default_agent_alias: agentAlias };
    setSettings(newSettings);
    saveSettingsOnly(newSettings);
  }, [settings, saveSettingsOnly]);

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

  const handleReindexAll = useCallback(async (ignoreCooldown = false) => {
    setIsReindexing(true);
    setGlobalError(null);
    try {
      const result = await triggerReindexAll(ignoreCooldown);
      if (result.success) {
        const skippedCount = (result.repositoriesSkippedCooldown ?? 0) + (result.repositoriesSkippedAlreadyQueued ?? 0) + (result.repositoriesFailedClone ?? 0);
        if (result.repositoriesQueued === 0 && skippedCount > 0) {
          setGlobalError(buildReindexAllSkipMessage(result));
          setSaveStatus('error');
          return;
        }
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
    triggerSettingsSave, handleModelSelectionChange, handleReviewContextEnabledChange,
    handleSummarizationChange, handleSummarizationModelChange,
    handleSummarizationFallbackModelChange,
    handleDefaultAgentChange, handleReindexAll, handleAgentTankChange,
    savePrLabelOnly,
    ...lists,
  };
}
