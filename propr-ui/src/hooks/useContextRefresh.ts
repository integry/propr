import { useState, useRef, useCallback, useEffect } from 'react';
import { getDraft, previewContext, PreviewResult, Granularity, PlannerAttachment, SmartFileSelection, PendingPreviewResult, DraftContextConfig } from '../api/proprApi';
import { useSocket } from '../contexts/useSocket';

const BRANCH_NAME_REGEX = /^[a-zA-Z0-9_\-./]+$/;
const DEBOUNCE_DELAY = 800;
/** Delay before auto-refreshing context after source changes (ms) */
const SOURCE_REFRESH_DELAY = 20000;
const WORD_OVERLAP_THRESHOLD = 0.5;

/** Tiktoken to Claude token ratio for estimation */
const TIKTOKEN_TO_CLAUDE_RATIO = 1.36;
/** Default model max tokens (200K for Claude) */
const DEFAULT_MODEL_MAX_TOKENS = 200000;

const extractWords = (prompt: string) => (prompt.toLowerCase().match(/\b[\w'-]+\b/g) ?? []);

/**
 * Simulate file selection for a given context level using cached fileTokenCounts.
 * Returns the filtered smartSelection and updated stats.
 */
function simulateContextLevel(
  originalData: PreviewResult,
  contextLevel: number,
  modelMaxTokens: number = DEFAULT_MODEL_MAX_TOKENS
): PreviewResult {
  const fileTokenCounts = originalData.fileTokenCounts;
  if (!fileTokenCounts || Object.keys(fileTokenCounts).length === 0) {
    return originalData;
  }

  // Calculate target token limit based on context level (0-100)
  const targetTokenLimit = Math.floor(modelMaxTokens * (contextLevel / 100) * 0.98);
  const targetTiktokenLimit = Math.floor(targetTokenLimit / TIKTOKEN_TO_CLAUDE_RATIO);

  // Get the original smartSelection excluding context-repo files (those are always included)
  const contextRepoFiles = originalData.smartSelection.filter(f => f.source === 'context-repo');
  const repoFiles = originalData.smartSelection.filter(f => f.source !== 'context-repo');

  // Sort by score descending (most relevant first), then by tokens ascending (smaller files preferred for tie-breaking)
  const sortedFiles = [...repoFiles].sort((a, b) => {
    const scoreDiff = (b.score ?? 0) - (a.score ?? 0);
    if (scoreDiff !== 0) return scoreDiff;
    return (fileTokenCounts[a.path] ?? 0) - (fileTokenCounts[b.path] ?? 0);
  });

  // Select files that fit within the token budget
  const selectedFiles: SmartFileSelection[] = [];
  let currentTokens = 0;

  for (const file of sortedFiles) {
    const fileTokens = fileTokenCounts[file.path] ?? 0;
    if (currentTokens + fileTokens <= targetTiktokenLimit) {
      selectedFiles.push(file);
      currentTokens += fileTokens;
    }
  }

  // Calculate new stats
  const estimatedActualTokens = Math.ceil(currentTokens * TIKTOKEN_TO_CLAUDE_RATIO);
  const attachmentTokens = originalData.stats.attachmentTokens ?? 0;
  const totalTokens = estimatedActualTokens + attachmentTokens;

  // Rough cost estimate (using Claude pricing)
  const costEstimate = (totalTokens / 1_000_000) * 3 + (4000 / 1_000_000) * 15;

  return {
    ...originalData,
    smartSelection: [...selectedFiles, ...contextRepoFiles],
    stats: {
      ...originalData.stats,
      totalTokens,
      fileCount: selectedFiles.length,
      costEstimate,
      maxTokens: Math.ceil(targetTokenLimit * TIKTOKEN_TO_CLAUDE_RATIO)
    }
  };
}

const isPendingPreview = (result: PreviewResult | PendingPreviewResult): result is PendingPreviewResult =>
  'pending' in result && result.pending === true;

function parseDraftContextConfig(value: unknown): DraftContextConfig | null {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as DraftContextConfig;
    } catch {
      return null;
    }
  }
  return value as DraftContextConfig;
}

function getCompletedPreviewFromDraft(contextConfig: unknown, previewRequestId: string): PreviewResult | null {
  const config = parseDraftContextConfig(contextConfig);
  if (!config?.lastPreview || config.lastPreviewRequestId !== previewRequestId) return null;
  return {
    ...config.lastPreview,
    fileTokenCounts: config.contextCache?.fileTokenCounts
  };
}

/**
 * Determine if a prompt change is significant enough to warrant auto-refresh.
 * Considers length delta and word overlap to filter out small typo/punctuation tweaks.
 */
const isSignificantPromptChange = (prevPrompt: string, nextPrompt: string): boolean => {
  if (prevPrompt === nextPrompt) return false;

  const lengthDiff = Math.abs(prevPrompt.length - nextPrompt.length);
  const baseLength = Math.max(prevPrompt.length, 1);
  if (lengthDiff > 20 || (lengthDiff / baseLength) > 0.2) return true;

  const prevWords = new Set(extractWords(prevPrompt));
  const nextWords = new Set(extractWords(nextPrompt));

  if (!prevWords.size && !nextWords.size) return false;

  let overlap = 0;
  prevWords.forEach(word => { if (nextWords.has(word)) overlap += 1; });
  const overlapRatio = overlap / Math.max(prevWords.size, nextWords.size, 1);

  return overlapRatio < WORD_OVERLAP_THRESHOLD;
};

export interface PreviewState {
  isLoading: boolean;
  data: PreviewResult | null;
  error: string | null;
  lastSynced: Date | null;
}

interface SourceConfig {
  prompt: string;
  baseBranch: string;
  filesLength: number;
  compress: boolean;
  manualFilesLength: number;
}

interface FetchConfig {
  prompt: string;
  baseBranch: string;
  granularity: Granularity;
  contextLevel: number;
  compress: boolean;
  files: PlannerAttachment[];
  /** Model to use for plan generation (determines context limits) */
  generationModel: string | null;
  /** Additional repositories to include as reference context */
  contextRepositories: { repository: string; branch?: string }[];
  /** File paths explicitly added by the user to include in context */
  manualFiles: string[];
  /** Files manually excluded from context by the user */
  excludedFiles: string[];
}

interface UseContextRefreshOptions {
  draftId: string;
  config: FetchConfig;
  onBranchError: (error: string | null) => void;
}

export function useContextRefresh({ draftId, config, onBranchError }: UseContextRefreshOptions) {
  const { subscribeToDraft, unsubscribeFromDraft, onDraftUpdate, isConnected } = useSocket();
  const [preview, setPreview] = useState<PreviewState>({
    isLoading: false,
    data: null,
    error: null,
    lastSynced: null
  });

  const [initialSyncDone, setInitialSyncDone] = useState<boolean>(false);
  const [timeUntilRefresh, setTimeUntilRefresh] = useState<number | null>(null);
  const [isContextStale, setIsContextStale] = useState<boolean>(false);
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const [pendingPreviewRequestId, setPendingPreviewRequestId] = useState<string | null>(null);
  // Track if countdown was started - prevents auto-fetch when context is stale but countdown hasn't begun
  const [countdownStarted, setCountdownStarted] = useState<boolean>(false);

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const configRef = useRef(config);
  const sourceRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastFetchedSourceRef = useRef<SourceConfig | null>(null);
  const pausedTimeRemainingRef = useRef<number | null>(null);
  // Track previous view settings to detect actual changes
  const prevViewSettingsRef = useRef<{ granularity: Granularity; contextLevel: number; generationModel: string | null } | null>(null);
  // Track isContextStale without triggering re-renders
  const isContextStaleRef = useRef<boolean>(false);
  // Track if we just completed a fetch to prevent immediate re-trigger
  const justFetchedRef = useRef<boolean>(false);
  // Track loading state for use in callbacks
  const isLoadingRef = useRef<boolean>(false);
  // Store the full preview data (at max context level) for local simulation
  const fullPreviewDataRef = useRef<PreviewResult | null>(null);
  // Track whether we've auto-paused after the first successful context fetch
  const hasAutoPausedRef = useRef<boolean>(false);
  const pendingPreviewRequestIdRef = useRef<string | null>(null);

  // Reset auto-pause tracking when draftId changes so it re-triggers for new drafts
  useEffect(() => {
    hasAutoPausedRef.current = false;
  }, [draftId]);

  // Keep config ref up to date
  useEffect(() => { configRef.current = config; }, [config]);

  // Keep isContextStaleRef in sync with state
  useEffect(() => { isContextStaleRef.current = isContextStale; }, [isContextStale]);

  // Keep isLoadingRef in sync with preview state
  useEffect(() => { isLoadingRef.current = preview.isLoading; }, [preview.isLoading]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      if (sourceRefreshTimerRef.current) clearTimeout(sourceRefreshTimerRef.current);
      if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
    };
  }, []);

  const markPreviewComplete = useCallback((result: PreviewResult) => {
    pendingPreviewRequestIdRef.current = null;
    setPendingPreviewRequestId(null);
    lastFetchedSourceRef.current = {
      prompt: configRef.current.prompt,
      baseBranch: configRef.current.baseBranch,
      filesLength: configRef.current.files.length,
      compress: configRef.current.compress,
      manualFilesLength: configRef.current.manualFiles.length
    };
    justFetchedRef.current = true;
    fullPreviewDataRef.current = result;
    setPreview({ isLoading: false, data: result, error: null, lastSynced: new Date() });
    if (!hasAutoPausedRef.current) {
      hasAutoPausedRef.current = true;
      setIsPaused(true);
    }
  }, []);

  const loadCompletedPreview = useCallback(async (previewRequestId: string): Promise<boolean> => {
    const draft = await getDraft(draftId);
    const completedPreview = getCompletedPreviewFromDraft(draft.context_config, previewRequestId);
    if (!completedPreview) return false;
    markPreviewComplete(completedPreview);
    return true;
  }, [draftId, markPreviewComplete]);

  const clearCountdown = useCallback(() => {
    if (sourceRefreshTimerRef.current) {
      clearTimeout(sourceRefreshTimerRef.current);
      sourceRefreshTimerRef.current = null;
    }
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
    setTimeUntilRefresh(null);
    setCountdownStarted(false);
  }, []);

  const fetchPreview = useCallback(async () => {
    const currentConfig = configRef.current;
    // Skip preview if no draftId (new mode - draft not created yet)
    if (!draftId) return;
    if (!currentConfig.prompt.trim() || !currentConfig.baseBranch) return;

    if (!BRANCH_NAME_REGEX.test(currentConfig.baseBranch)) {
      onBranchError('Invalid branch name format');
      return;
    }
    onBranchError(null);

    clearCountdown();
    setIsContextStale(false);

    if (abortControllerRef.current) abortControllerRef.current.abort();

    const controller = new AbortController();
    abortControllerRef.current = controller;

    setPreview(prev => ({ ...prev, isLoading: true, error: null }));
    pendingPreviewRequestIdRef.current = null;
    setPendingPreviewRequestId(null);

    try {
      // Combine attachment file names and manual file paths
      const allFiles = [
        ...currentConfig.files.map(f => f.originalName),
        ...currentConfig.manualFiles
      ];
      const result = await previewContext({
        draftId,
        prompt: currentConfig.prompt,
        baseBranch: currentConfig.baseBranch,
        granularity: currentConfig.granularity,
        contextLevel: currentConfig.contextLevel,
        compress: currentConfig.compress,
        files: allFiles.length > 0 ? allFiles : undefined,
        generationModel: currentConfig.generationModel || undefined,
        contextRepositories: currentConfig.contextRepositories.length > 0 ? currentConfig.contextRepositories : undefined,
        excludedFiles: currentConfig.excludedFiles.length > 0 ? currentConfig.excludedFiles : undefined
      }, controller.signal);

      if (isPendingPreview(result)) {
        pendingPreviewRequestIdRef.current = result.previewRequestId;
        setPendingPreviewRequestId(result.previewRequestId);
      } else {
        markPreviewComplete(result);
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      const errorMessage = (err as Error).message || 'Failed to fetch preview';
      setPreview(prev => ({ ...prev, isLoading: false, error: errorMessage }));
      if (errorMessage.toLowerCase().includes('branch')) onBranchError(errorMessage);
    }
  }, [draftId, clearCountdown, onBranchError, markPreviewComplete]);

  useEffect(() => {
    if (!draftId || !preview.isLoading || !pendingPreviewRequestId) return;

    loadCompletedPreview(pendingPreviewRequestId).catch(() => { /* Keep waiting for socket or next poll. */ });
    const interval = setInterval(() => {
      loadCompletedPreview(pendingPreviewRequestId).catch(() => { /* Keep waiting for socket or next poll. */ });
    }, 5000);

    return () => clearInterval(interval);
  }, [draftId, preview.isLoading, pendingPreviewRequestId, loadCompletedPreview]);

  useEffect(() => {
    if (!draftId || !preview.isLoading || !pendingPreviewRequestId || !isConnected) return;
    subscribeToDraft(draftId);
    const unsubscribe = onDraftUpdate((payload) => {
      if (payload.draftId !== draftId || payload.step !== 'context') return;
      if (payload.status === 'failed') {
        pendingPreviewRequestIdRef.current = null;
        setPendingPreviewRequestId(null);
        setPreview(prev => ({
          ...prev,
          isLoading: false,
          error: typeof payload.data?.error === 'string' ? payload.data.error : 'Failed to fetch preview'
        }));
        return;
      }
      if (payload.status !== 'completed') return;
      if (payload.data?.previewRequestId !== pendingPreviewRequestId) return;
      loadCompletedPreview(pendingPreviewRequestId).catch((error) => {
        setPreview(prev => ({ ...prev, isLoading: false, error: (error as Error).message || 'Failed to load completed preview' }));
      });
    });

    return () => {
      unsubscribeFromDraft(draftId);
      unsubscribe();
    };
  }, [draftId, preview.isLoading, pendingPreviewRequestId, isConnected, subscribeToDraft, unsubscribeFromDraft, onDraftUpdate, loadCompletedPreview]);

  const startCountdown = useCallback(() => {
    clearCountdown();
    setIsContextStale(true);
    setCountdownStarted(true);
    setTimeUntilRefresh(SOURCE_REFRESH_DELAY / 1000);

    countdownIntervalRef.current = setInterval(() => {
      setTimeUntilRefresh(prev => (prev === null || prev <= 1) ? null : prev - 1);
    }, 1000);

    sourceRefreshTimerRef.current = setTimeout(() => {
      clearCountdown();
      setIsContextStale(false);
      // Only trigger fetch if not already loading (use ref for current state)
      if (!isLoadingRef.current) {
        fetchPreview();
      }
    }, SOURCE_REFRESH_DELAY);
  }, [clearCountdown, fetchPreview]);

  // Initial setup - initialize tracking state but don't fetch immediately
  // Context gathering should wait until the first debounce period completes
  // (or when explicitly requested via refresh button)
  useEffect(() => {
    if (!initialSyncDone && config.baseBranch && config.prompt.trim()) {
      setInitialSyncDone(true);
      // Mark context as stale and start the countdown instead of fetching immediately
      setIsContextStale(true);
      startCountdown();
    }
  }, [config.baseBranch, config.prompt, config.files.length, config.compress, config.manualFiles.length, initialSyncDone, startCountdown]);

  // Source changes - start countdown (unless paused)
  useEffect(() => {
    if (!initialSyncDone) return;

    // Skip if we just completed a fetch - prevents immediate re-trigger loop
    if (justFetchedRef.current) {
      justFetchedRef.current = false;
      return;
    }

    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);

    const lastFetched = lastFetchedSourceRef.current;
    const currentSource: SourceConfig = {
      prompt: config.prompt,
      baseBranch: config.baseBranch,
      filesLength: config.files.length,
      compress: config.compress,
      manualFilesLength: config.manualFiles.length
    };

    const isStrictlyStale = !lastFetched || (
      lastFetched.prompt !== currentSource.prompt ||
      lastFetched.baseBranch !== currentSource.baseBranch ||
      lastFetched.filesLength !== currentSource.filesLength ||
      lastFetched.compress !== currentSource.compress ||
      lastFetched.manualFilesLength !== currentSource.manualFilesLength
    );

    const isSignificant = !lastFetched ||
      lastFetched.baseBranch !== currentSource.baseBranch ||
      lastFetched.filesLength !== currentSource.filesLength ||
      lastFetched.compress !== currentSource.compress ||
      lastFetched.manualFilesLength !== currentSource.manualFilesLength ||
      isSignificantPromptChange(lastFetched.prompt, currentSource.prompt);

    if (!isStrictlyStale) {
      clearCountdown();
      // Use ref to avoid triggering effect re-run
      if (isContextStaleRef.current) setIsContextStale(false);
      return;
    }

    setIsContextStale(true);

    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);

    if (!isSignificant || isPaused) {
      clearCountdown();
      return;
    }

    debounceTimerRef.current = setTimeout(() => startCountdown(), DEBOUNCE_DELAY);
    return () => { if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current); };
  // Note: isContextStale intentionally not in deps - we use isContextStaleRef to check without re-triggering
  }, [config.prompt, config.baseBranch, config.files.length, config.compress, config.manualFiles.length, initialSyncDone, isPaused, clearCountdown, startCountdown]);

  // View changes - handle context level locally, fetch for granularity/model changes
  useEffect(() => {
    if (!initialSyncDone) return;

    const currentViewSettings = {
      granularity: config.granularity,
      contextLevel: config.contextLevel,
      generationModel: config.generationModel
    };

    const prevSettings = prevViewSettingsRef.current;

    // Check what changed (granularity doesn't affect context, only plan generation)
    const contextLevelChanged = prevSettings !== null && prevSettings.contextLevel !== currentViewSettings.contextLevel;
    const modelChanged = prevSettings !== null && prevSettings.generationModel !== currentViewSettings.generationModel;

    // Update the ref for next comparison
    prevViewSettingsRef.current = currentViewSettings;

    // If context is stale, don't do anything - wait for content refresh
    if (isContextStaleRef.current) return;

    // Handle context level changes locally if we have cached data
    const fullData = fullPreviewDataRef.current;
    if (contextLevelChanged && !modelChanged && fullData?.fileTokenCounts) {
      const modelMaxTokens = fullData.stats.modelMaxContextTokens || DEFAULT_MODEL_MAX_TOKENS;
      const simulatedData = simulateContextLevel(fullData, config.contextLevel, modelMaxTokens);
      setPreview(prev => ({ ...prev, data: simulatedData }));
      return;
    }

    // Granularity changes don't affect context - only plan generation
    // Only model changes need server refresh (different context window)
    if (modelChanged) {
      fetchPreview();
    }
  }, [config.contextLevel, config.granularity, config.generationModel, initialSyncDone, fetchPreview]);

  // Timer expiry - auto-fetch when countdown ends (only if not paused and countdown was started)
  // Note: countdownStarted ensures we don't auto-fetch when context becomes stale but countdown hasn't begun
  useEffect(() => {
    if (timeUntilRefresh === null && isContextStale && initialSyncDone && !isPaused && countdownStarted) {
      setIsContextStale(false);
      setCountdownStarted(false);
      fetchPreview();
    }
  }, [timeUntilRefresh, isContextStale, initialSyncDone, isPaused, countdownStarted, fetchPreview]);

  const handleManualRefresh = useCallback(() => {
    clearCountdown();
    setIsContextStale(false);
    pausedTimeRemainingRef.current = null;
    fetchPreview();
  }, [clearCountdown, fetchPreview]);

  const togglePause = useCallback(() => {
    setIsPaused(prev => {
      const newPaused = !prev;
      if (newPaused) {
        // Pausing: save current time remaining and clear the countdown
        pausedTimeRemainingRef.current = timeUntilRefresh;
        if (sourceRefreshTimerRef.current) {
          clearTimeout(sourceRefreshTimerRef.current);
          sourceRefreshTimerRef.current = null;
        }
        if (countdownIntervalRef.current) {
          clearInterval(countdownIntervalRef.current);
          countdownIntervalRef.current = null;
        }
      } else {
        // Resuming: restart countdown from where we left off
        const remaining = pausedTimeRemainingRef.current;
        if (remaining !== null && remaining > 0 && isContextStale) {
          setTimeUntilRefresh(remaining);

          countdownIntervalRef.current = setInterval(() => {
            setTimeUntilRefresh(p => (p === null || p <= 1) ? null : p - 1);
          }, 1000);

          sourceRefreshTimerRef.current = setTimeout(() => {
            clearCountdown();
            setIsContextStale(false);
            // Trigger the fetch when countdown completes
            fetchPreview();
          }, remaining * 1000);
        }
        pausedTimeRemainingRef.current = null;
      }
      return newPaused;
    });
  }, [timeUntilRefresh, isContextStale, clearCountdown, fetchPreview]);

  return {
    preview,
    isContextStale,
    timeUntilRefresh,
    isPaused,
    fetchPreview,
    handleManualRefresh,
    clearCountdown,
    togglePause
  };
}
