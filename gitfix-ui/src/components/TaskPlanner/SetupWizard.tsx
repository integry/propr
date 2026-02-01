import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  uploadAttachment,
  removeAttachment,
  generatePlan,
  previewContext,
  getRepositoryInfo,
  PlannerDraft,
  PlannerAttachment,
  Granularity,
  PreviewResult,
  ContextRepository
} from '../../api/gitfixApi';
import { getRepositoriesIndexingStatus, RepositoryIndexingStatus } from '../../api/repoIndexingApi';
import { getPlannerSettings, savePlannerSettings } from '../../hooks/usePlannerSettings';
import { useGenerationPolling } from '../../hooks/useGenerationPolling';
import { useContextExport } from '../../hooks/useContextExport';
import { GenerationProgress } from './GenerationProgress';
import { SmartFileSelection } from './SmartFileSelection';
import { resizeImage } from './imageUtils';
import { GenerateButton } from './GenerateButton';
import { FileSelectionSkeleton } from './SkeletonLoader';
import { ContextHeader } from './ContextHeader';
import { HeroPromptArea } from './HeroPromptArea';
import { TaskGranularitySection } from './TaskGranularitySection';
import { ContextSettingsSection } from './ContextSettingsSection';
import { ContextRepositoriesSection, IndexedRepository } from './ContextRepositoriesSection';
import { CostPreview } from './CostPreview';
import { ExportContextButton } from './ExportContextButton';

interface SetupWizardProps {
  draft: PlannerDraft;
  onGenerateComplete: () => void;
}

const BRANCH_NAME_REGEX = /^[a-zA-Z0-9_\-./]+$/;
const DEBOUNCE_DELAY = 800;
/** Delay before auto-refreshing context after source changes (ms) */
const SOURCE_REFRESH_DELAY = 60000;
/** Slider debounce delay for context level changes (ms) */
const SLIDER_DEBOUNCE_DELAY = 300;

interface PlannerConfig {
  prompt: string;
  baseBranch: string;
  granularity: Granularity;
  contextLevel: number;
  compress: boolean;
  files: PlannerAttachment[];
  contextRepositories: ContextRepository[];
}

interface PreviewState {
  isLoading: boolean;
  data: PreviewResult | null;
  error: string | null;
  lastSynced: Date | null;
}

interface RepoInfoState {
  isLoading: boolean;
  branches: string[];
  error: string | null;
}

export const SetupWizard: React.FC<SetupWizardProps> = ({ draft, onGenerateComplete }) => {
  // Load saved settings from localStorage
  const savedSettings = getPlannerSettings();

  const [config, setConfig] = useState<PlannerConfig>({
    prompt: draft.initial_prompt || '',
    baseBranch: '',
    granularity: savedSettings.lastGranularity,
    contextLevel: savedSettings.lastContextLevel,
    compress: false,
    files: draft.attachments || [],
    contextRepositories: []
  });

  const [availableRepos, setAvailableRepos] = useState<IndexedRepository[]>([]);

  const [preview, setPreview] = useState<PreviewState>({
    isLoading: false,
    data: null,
    error: null,
    lastSynced: null
  });

  const [repoInfo, setRepoInfo] = useState<RepoInfoState>({
    isLoading: true,
    branches: [],
    error: null
  });

  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [initialSyncDone, setInitialSyncDone] = useState<boolean>(false);
  /** Time remaining until auto-refresh (in seconds), null if no countdown active */
  const [timeUntilRefresh, setTimeUntilRefresh] = useState<number | null>(null);
  /** Whether the context is stale (source changed but not yet refreshed) */
  const [isContextStale, setIsContextStale] = useState<boolean>(false);

  const { isGenerating, generationTrace, generationError, startPolling, setGenerationError } =
    useGenerationPolling({ draftId: draft.draft_id, onComplete: onGenerateComplete });
  const { isExporting, exportContext } = useContextExport(setError);

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const configRef = useRef(config);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /** Timer for the source refresh countdown */
  const sourceRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Interval for updating the countdown display */
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Track previous source values to detect changes */
  const prevSourceRef = useRef<{ prompt: string; baseBranch: string; filesLength: number; compress: boolean } | null>(null);

  useEffect(() => { configRef.current = config; }, [config]);

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      if (sourceRefreshTimerRef.current) {
        clearTimeout(sourceRefreshTimerRef.current);
      }
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current);
      }
    };
  }, []);

  const autoResize = useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.max(textarea.scrollHeight, 160)}px`;
    }
  }, []);

  useEffect(() => { autoResize(); }, [config.prompt, autoResize]);

  useEffect(() => {
    const loadRepoInfo = async () => {
      try {
        const info = await getRepositoryInfo(draft.draft_id);
        setRepoInfo({ isLoading: false, branches: info.branches, error: null });
        setConfig(prev => ({ ...prev, baseBranch: info.defaultBranch }));
      } catch (err) {
        setRepoInfo({ isLoading: false, branches: [], error: (err as Error).message });
        setConfig(prev => ({ ...prev, baseBranch: 'main' }));
      }
    };
    loadRepoInfo();
  }, [draft.draft_id]);

  // Load available indexed repositories for context repositories section
  useEffect(() => {
    const loadAvailableRepos = async () => {
      try {
        const data = await getRepositoriesIndexingStatus();
        // Filter to only completed indexed repos and exclude the target repository
        const indexedRepos: IndexedRepository[] = (data.repositories || [])
          .filter((repo: RepositoryIndexingStatus) =>
            repo.indexing_status === 'completed' && repo.full_name !== draft.repository
          )
          .map((repo: RepositoryIndexingStatus) => ({
            full_name: repo.full_name,
            branch: repo.branch
          }));
        setAvailableRepos(indexedRepos);
      } catch (error) {
        console.error('Failed to load indexed repos:', error);
      }
    };
    loadAvailableRepos();
  }, [draft.repository]);

  /** Clear the countdown timer and stale state */
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

  /** Start the countdown timer for source refresh */
  const startCountdown = useCallback(() => {
    clearCountdown();
    setIsContextStale(true);
    setTimeUntilRefresh(SOURCE_REFRESH_DELAY / 1000);

    // Start interval to update countdown every second
    countdownIntervalRef.current = setInterval(() => {
      setTimeUntilRefresh(prev => {
        if (prev === null || prev <= 1) {
          return null;
        }
        return prev - 1;
      });
    }, 1000);

    // Set timer to trigger refresh after delay
    sourceRefreshTimerRef.current = setTimeout(() => {
      clearCountdown();
      setIsContextStale(false);
      // fetchPreview will be called by the effect
    }, SOURCE_REFRESH_DELAY);
  }, [clearCountdown]);

  const fetchPreview = useCallback(async () => {
    const currentConfig = configRef.current;
    if (!currentConfig.prompt.trim() || !currentConfig.baseBranch) {
      return;
    }

    if (!BRANCH_NAME_REGEX.test(currentConfig.baseBranch)) {
      setBranchError('Invalid branch name format');
      return;
    }
    setBranchError(null);

    // Clear countdown and stale state when fetching
    clearCountdown();
    setIsContextStale(false);

    // Abort any previous request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    // Create new controller for this request
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setPreview(prev => ({ ...prev, isLoading: true, error: null }));

    try {
      const result = await previewContext({
        draftId: draft.draft_id,
        prompt: currentConfig.prompt,
        baseBranch: currentConfig.baseBranch,
        granularity: currentConfig.granularity,
        contextLevel: currentConfig.contextLevel,
        compress: currentConfig.compress,
        files: currentConfig.files.map(f => f.originalName)
      }, controller.signal);

      setPreview({
        isLoading: false,
        data: result,
        error: null,
        lastSynced: new Date()
      });
    } catch (err) {
      // Ignore abort errors - these are expected when we cancel requests
      if ((err as Error).name === 'AbortError') {
        return;
      }
      const errorMessage = (err as Error).message || 'Failed to fetch preview';
      setPreview(prev => ({
        ...prev,
        isLoading: false,
        error: errorMessage
      }));
      if (errorMessage.toLowerCase().includes('branch')) {
        setBranchError(errorMessage);
      }
    }
  }, [draft.draft_id, clearCountdown]);

  // Initial sync - fetch preview when we first have valid config
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

  // SOURCE CHANGES: prompt, baseBranch, files, compress - start countdown
  useEffect(() => {
    if (!initialSyncDone) return;

    const prev = prevSourceRef.current;
    const sourceChanged = prev && (
      prev.prompt !== config.prompt ||
      prev.baseBranch !== config.baseBranch ||
      prev.filesLength !== config.files.length ||
      prev.compress !== config.compress
    );

    // Update the ref for next comparison
    prevSourceRef.current = {
      prompt: config.prompt,
      baseBranch: config.baseBranch,
      filesLength: config.files.length,
      compress: config.compress
    };

    if (sourceChanged) {
      // Debounce the countdown start to avoid flickering while typing
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }

      debounceTimerRef.current = setTimeout(() => {
        startCountdown();
      }, DEBOUNCE_DELAY);

      return () => {
        if (debounceTimerRef.current) {
          clearTimeout(debounceTimerRef.current);
        }
      };
    }
  }, [config.prompt, config.baseBranch, config.files.length, config.compress, initialSyncDone, startCountdown]);

  // VIEW CHANGES: granularity, contextLevel - fetch immediately (uses cached context)
  useEffect(() => {
    if (!initialSyncDone || isContextStale) return;

    // Debounce slider changes to avoid rapid-fire requests
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = setTimeout(() => {
      fetchPreview();
    }, SLIDER_DEBOUNCE_DELAY);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [config.granularity, config.contextLevel, initialSyncDone, isContextStale, fetchPreview]);

  // Timer expiry - fetch preview when countdown reaches 0
  useEffect(() => {
    if (timeUntilRefresh === null && isContextStale && initialSyncDone) {
      // Timer expired, fetch preview
      setIsContextStale(false);
      fetchPreview();
    }
  }, [timeUntilRefresh, isContextStale, initialSyncDone, fetchPreview]);

  // Save granularity and context level to localStorage when they change
  useEffect(() => {
    savePlannerSettings({
      lastGranularity: config.granularity,
      lastContextLevel: config.contextLevel,
    });
  }, [config.granularity, config.contextLevel]);

  // Save repository to localStorage when draft is loaded (repository is set in the draft)
  useEffect(() => {
    if (draft.repository) {
      savePlannerSettings({ lastRepository: draft.repository });
    }
  }, [draft.repository]);

  const handleUpload = async (file: File) => {
    setIsUploading(true);
    setError(null);

    try {
      const attachment = await uploadAttachment(draft.draft_id, file);
      setConfig(prev => ({ ...prev, files: [...prev.files, attachment] }));
    } catch (err) {
      setError((err as Error).message || 'Failed to upload file');
    } finally {
      setIsUploading(false);
    }
  };

  const handleRemoveFile = async (attachmentId: string) => {
    try {
      await removeAttachment(draft.draft_id, attachmentId);
      setConfig(prev => ({ ...prev, files: prev.files.filter(f => f.id !== attachmentId) }));
    } catch (err) {
      setError((err as Error).message || 'Failed to remove file');
    }
  };

  const handleAddContextRepo = (repo: ContextRepository) => {
    setConfig(prev => ({
      ...prev,
      contextRepositories: [...prev.contextRepositories, repo]
    }));
  };

  const handleRemoveContextRepo = (repository: string) => {
    setConfig(prev => ({
      ...prev,
      contextRepositories: prev.contextRepositories.filter(r => r.repository !== repository)
    }));
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const blob = item.getAsFile();
        if (!blob) continue;

        const filename = `pasted-image-${Date.now()}.png`;
        const file = new File([blob], filename, { type: blob.type });

        try {
          const processedFile = await resizeImage(file);
          await handleUpload(processedFile);
        } catch (err) {
          setError('Failed to process pasted image');
          console.error('Paste error:', err);
        }
        return;
      }
    }
  };

  const handleExportContext = useCallback(() => {
    exportContext({
      draftId: draft.draft_id,
      prompt: config.prompt,
      baseBranch: config.baseBranch,
      granularity: config.granularity,
      contextLevel: config.contextLevel,
      compress: config.compress,
      files: config.files
    });
  }, [exportContext, draft.draft_id, config]);

  /** Manual refresh handler - force immediate context refresh */
  const handleManualRefresh = useCallback(() => {
    clearCountdown();
    setIsContextStale(false);
    fetchPreview();
  }, [clearCountdown, fetchPreview]);

  const handleGenerate = async () => {
    if (branchError) {
      setError('Please fix the branch name before generating');
      return;
    }

    setError(null);
    setGenerationError(null);

    try {
      // If context is stale, force refresh first to ensure latest prompt is saved
      if (isContextStale) {
        clearCountdown();
        setIsContextStale(false);
        await fetchPreview();
      }

      // Start generation - returns immediately with 202
      await generatePlan(draft.draft_id, {
        baseBranch: config.baseBranch,
        granularity: config.granularity,
        contextLevel: config.contextLevel,
        compress: config.compress,
        contextRepositories: config.contextRepositories
      });
      startPolling();
    } catch (err) {
      setError((err as Error).message || 'Failed to start plan generation');
    }
  };

  const isGenerateDisabled = isGenerating || !!branchError || repoInfo.isLoading;

  return (
    <div className="max-w-4xl mx-auto flex flex-col min-h-[calc(100vh-200px)]">
      {/* Context Header - Repository and Branch */}
      <ContextHeader
        repository={draft.repository}
        baseBranch={config.baseBranch}
        branches={repoInfo.branches}
        isLoading={repoInfo.isLoading}
        error={branchError || repoInfo.error}
        onBranchChange={(branch) => setConfig(prev => ({ ...prev, baseBranch: branch }))}
      />

      {/* Main content area */}
      <div className="flex-1 bg-white rounded-b-xl shadow-lg">
        <div className="p-6 space-y-6">
          {/* Hero Prompt Area */}
          <HeroPromptArea
            prompt={config.prompt}
            files={config.files}
            draftId={draft.draft_id}
            isUploading={isUploading}
            textareaRef={textareaRef}
            onPromptChange={(prompt) => setConfig(prev => ({ ...prev, prompt }))}
            onInput={autoResize}
            onPaste={handlePaste}
            onUpload={handleUpload}
            onRemoveFile={handleRemoveFile}
          />

          {/* Task Granularity Section - now separate from Context Settings */}
          <TaskGranularitySection
            granularity={config.granularity}
            onGranularityChange={(granularity) => setConfig(prev => ({ ...prev, granularity }))}
          />

          {/* Context Settings Section */}
          <ContextSettingsSection
            contextLevel={config.contextLevel}
            compress={config.compress}
            onContextLevelChange={(contextLevel) => setConfig(prev => ({ ...prev, contextLevel }))}
            onCompressChange={(compress) => setConfig(prev => ({ ...prev, compress }))}
            modelName={preview.data?.stats.modelName}
            modelMaxContextTokens={preview.data?.stats.modelMaxContextTokens}
          />

          {/* Context Repositories Section */}
          <ContextRepositoriesSection
            repositories={config.contextRepositories}
            availableRepos={availableRepos}
            onAdd={handleAddContextRepo}
            onRemove={handleRemoveContextRepo}
          />

          {/* Cost Preview with Refresh Indicator */}
          <div className="relative">
            <CostPreview
              preview={preview}
              contextRepositories={config.contextRepositories}
            />
            {/* Context Refresh Indicator */}
            {(isContextStale || timeUntilRefresh !== null) && (
              <div className="mt-2 flex items-center justify-between p-3 bg-amber-50 border border-amber-200 rounded-lg">
                <div className="flex items-center gap-2 text-amber-700">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span className="text-sm">
                    {timeUntilRefresh !== null
                      ? `Context will refresh in ${timeUntilRefresh}s`
                      : 'Context is stale'}
                  </span>
                </div>
                <button
                  onClick={handleManualRefresh}
                  disabled={preview.isLoading}
                  className="px-3 py-1 text-sm font-medium text-amber-700 bg-amber-100 hover:bg-amber-200 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                >
                  <svg className={`w-4 h-4 ${preview.isLoading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  Refresh Now
                </button>
              </div>
            )}
          </div>

          {/* Smart File Selection - with skeleton during loading */}
          {preview.isLoading && !preview.data ? (
            <FileSelectionSkeleton />
          ) : preview.data && (
            <SmartFileSelection smartSelection={preview.data.smartSelection} />
          )}

          {/* Error display */}
          {(error || generationError) && (
            <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-red-700">
              {error || generationError}
            </div>
          )}

          {/* Generation Progress */}
          {isGenerating && <GenerationProgress trace={generationTrace} />}
        </div>

        {/* Sticky Footer with Generate and Export Buttons */}
        <div className="sticky bottom-0 bg-white border-t border-gray-200 p-4 rounded-b-xl space-y-3">
          <GenerateButton
            isGenerating={isGenerating}
            isRepoLoading={repoInfo.isLoading}
            disabled={isGenerateDisabled}
            onClick={handleGenerate}
          />
          <ExportContextButton
            isExporting={isExporting}
            isPreviewLoading={preview.isLoading}
            canExport={!!(config.prompt.trim() && config.baseBranch)}
            onExport={handleExportContext}
          />
        </div>
      </div>
    </div>
  );
};

export default SetupWizard;
