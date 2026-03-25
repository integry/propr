import { useState, useRef, useCallback, useEffect } from 'react';
import { previewContext, PreviewResult, Granularity, PlannerAttachment } from '../api/proprApi';

const BRANCH_NAME_REGEX = /^[a-zA-Z0-9_\-./]+$/;
const DEBOUNCE_DELAY = 800;
/** Delay before auto-refreshing context after source changes (ms) */
const SOURCE_REFRESH_DELAY = 20000;
/** Slider debounce delay for context level changes (ms) */
const SLIDER_DEBOUNCE_DELAY = 300;
const WORD_OVERLAP_THRESHOLD = 0.5;

const extractWords = (prompt: string) => (prompt.toLowerCase().match(/\b[\w'-]+\b/g) ?? []);

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
}

interface UseContextRefreshOptions {
  draftId: string;
  config: FetchConfig;
  onBranchError: (error: string | null) => void;
}

export function useContextRefresh({ draftId, config, onBranchError }: UseContextRefreshOptions) {
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
        contextRepositories: currentConfig.contextRepositories.length > 0 ? currentConfig.contextRepositories : undefined
      }, controller.signal);

      lastFetchedSourceRef.current = {
        prompt: currentConfig.prompt,
        baseBranch: currentConfig.baseBranch,
        filesLength: currentConfig.files.length,
        compress: currentConfig.compress,
        manualFilesLength: currentConfig.manualFiles.length
      };

      // Mark that we just fetched to prevent source change effect from re-triggering
      justFetchedRef.current = true;

      setPreview({ isLoading: false, data: result, error: null, lastSynced: new Date() });
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      const errorMessage = (err as Error).message || 'Failed to fetch preview';
      setPreview(prev => ({ ...prev, isLoading: false, error: errorMessage }));
      if (errorMessage.toLowerCase().includes('branch')) onBranchError(errorMessage);
    }
  }, [draftId, clearCountdown, onBranchError]);

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

  // View changes - fetch immediately (granularity, contextLevel, generationModel)
  // Only triggers when actual view settings change, not when isContextStale transitions
  useEffect(() => {
    if (!initialSyncDone) return;

    const currentViewSettings = {
      granularity: config.granularity,
      contextLevel: config.contextLevel,
      generationModel: config.generationModel
    };

    const prevSettings = prevViewSettingsRef.current;

    // Check if view settings actually changed
    const viewSettingsChanged = prevSettings !== null && (
      prevSettings.granularity !== currentViewSettings.granularity ||
      prevSettings.contextLevel !== currentViewSettings.contextLevel ||
      prevSettings.generationModel !== currentViewSettings.generationModel
    );

    // Update the ref for next comparison
    prevViewSettingsRef.current = currentViewSettings;

    // Only fetch if settings actually changed and context is not stale
    // Use ref to avoid dependency on isContextStale state
    if (!viewSettingsChanged || isContextStaleRef.current) return;

    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => fetchPreview(), SLIDER_DEBOUNCE_DELAY);
    return () => { if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current); };
  }, [config.granularity, config.contextLevel, config.generationModel, initialSyncDone, fetchPreview]);

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
