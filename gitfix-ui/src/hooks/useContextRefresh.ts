import { useState, useRef, useCallback, useEffect } from 'react';
import { previewContext, PreviewResult, Granularity, PlannerAttachment } from '../api/gitfixApi';

const BRANCH_NAME_REGEX = /^[a-zA-Z0-9_\-./]+$/;
const DEBOUNCE_DELAY = 800;
/** Delay before auto-refreshing context after source changes (ms) */
const SOURCE_REFRESH_DELAY = 60000;
/** Slider debounce delay for context level changes (ms) */
const SLIDER_DEBOUNCE_DELAY = 300;

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

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const configRef = useRef(config);
  const sourceRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevSourceRef = useRef<SourceConfig | null>(null);
  const pausedTimeRemainingRef = useRef<number | null>(null);

  // Keep config ref up to date
  useEffect(() => { configRef.current = config; }, [config]);

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
      const result = await previewContext({
        draftId,
        prompt: currentConfig.prompt,
        baseBranch: currentConfig.baseBranch,
        granularity: currentConfig.granularity,
        contextLevel: currentConfig.contextLevel,
        compress: currentConfig.compress,
        files: currentConfig.files.map(f => f.originalName),
        generationModel: currentConfig.generationModel || undefined
      }, controller.signal);

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
    setTimeUntilRefresh(SOURCE_REFRESH_DELAY / 1000);

    countdownIntervalRef.current = setInterval(() => {
      setTimeUntilRefresh(prev => (prev === null || prev <= 1) ? null : prev - 1);
    }, 1000);

    sourceRefreshTimerRef.current = setTimeout(() => {
      clearCountdown();
      setIsContextStale(false);
      // Trigger the fetch when countdown completes
      fetchPreview();
    }, SOURCE_REFRESH_DELAY);
  }, [clearCountdown, fetchPreview]);

  // Initial sync
  useEffect(() => {
    if (!initialSyncDone && config.baseBranch && config.prompt.trim()) {
      setInitialSyncDone(true);
      prevSourceRef.current = {
        prompt: config.prompt,
        baseBranch: config.baseBranch,
        filesLength: config.files.length,
        compress: config.compress
      };
      fetchPreview();
    }
  }, [config.baseBranch, config.prompt, config.files.length, config.compress, initialSyncDone, fetchPreview]);

  // Source changes - start countdown (unless paused)
  useEffect(() => {
    if (!initialSyncDone) return;

    const prev = prevSourceRef.current;
    const sourceChanged = prev && (
      prev.prompt !== config.prompt ||
      prev.baseBranch !== config.baseBranch ||
      prev.filesLength !== config.files.length ||
      prev.compress !== config.compress
    );

    prevSourceRef.current = {
      prompt: config.prompt,
      baseBranch: config.baseBranch,
      filesLength: config.files.length,
      compress: config.compress
    };

    if (sourceChanged) {
      // Mark context as stale even when paused
      setIsContextStale(true);

      // Only start countdown if not paused
      if (!isPaused) {
        if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = setTimeout(() => startCountdown(), DEBOUNCE_DELAY);
        return () => { if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current); };
      }
    }
  }, [config.prompt, config.baseBranch, config.files.length, config.compress, initialSyncDone, isPaused, startCountdown]);

  // View changes - fetch immediately (granularity, contextLevel, generationModel)
  useEffect(() => {
    if (!initialSyncDone || isContextStale) return;

    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => fetchPreview(), SLIDER_DEBOUNCE_DELAY);
    return () => { if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current); };
  }, [config.granularity, config.contextLevel, config.generationModel, initialSyncDone, isContextStale, fetchPreview]);

  // Timer expiry - auto-fetch when countdown ends (only if not paused)
  useEffect(() => {
    if (timeUntilRefresh === null && isContextStale && initialSyncDone && !isPaused) {
      setIsContextStale(false);
      fetchPreview();
    }
  }, [timeUntilRefresh, isContextStale, initialSyncDone, isPaused, fetchPreview]);

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
