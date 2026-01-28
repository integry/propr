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
  PreviewResult
} from '../../api/gitfixApi';
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
import { ContextSettingsSection } from './ContextSettingsSection';
import { CostPreviewSection } from './CostPreviewSection';

interface SetupWizardProps {
  draft: PlannerDraft;
  onGenerateComplete: () => void;
}

const BRANCH_NAME_REGEX = /^[a-zA-Z0-9_\-./]+$/;
const DEBOUNCE_DELAY = 800;

interface PlannerConfig {
  prompt: string;
  baseBranch: string;
  granularity: Granularity;
  contextLevel: number;
  compress: boolean;
  files: PlannerAttachment[];
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
    files: draft.attachments || []
  });

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

  const { isGenerating, generationTrace, generationError, startPolling, setGenerationError } =
    useGenerationPolling({ draftId: draft.draft_id, onComplete: onGenerateComplete });
  const { isExporting, exportContext } = useContextExport(setError);

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const configRef = useRef(config);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { configRef.current = config; }, [config]);

  useEffect(() => {
    return () => { abortControllerRef.current?.abort(); };
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
  }, [draft.draft_id]);

  useEffect(() => {
    if (!initialSyncDone && config.baseBranch && config.prompt.trim()) {
      setInitialSyncDone(true);
      fetchPreview();
    }
  }, [config.baseBranch, config.prompt, initialSyncDone, fetchPreview]);

  useEffect(() => {
    if (!initialSyncDone) return;

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = setTimeout(() => {
      fetchPreview();
    }, DEBOUNCE_DELAY);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [config.prompt, config.baseBranch, config.granularity, config.contextLevel, config.compress, fetchPreview, initialSyncDone]);

  useEffect(() => {
    if (initialSyncDone && config.files.length > 0) {
      fetchPreview();
    }
  }, [config.files.length, fetchPreview, initialSyncDone]);

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

  const handleGenerate = async () => {
    if (branchError) {
      setError('Please fix the branch name before generating');
      return;
    }

    setError(null);
    setGenerationError(null);

    try {
      // Start generation - returns immediately with 202
      await generatePlan(draft.draft_id, {
        baseBranch: config.baseBranch,
        granularity: config.granularity,
        contextLevel: config.contextLevel,
        compress: config.compress
      });
      startPolling();
    } catch (err) {
      setError((err as Error).message || 'Failed to start plan generation');
    }
  };

  const isGenerateDisabled = isGenerating || preview.isLoading || !!branchError || repoInfo.isLoading;

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

          {/* Context Settings Section */}
          <ContextSettingsSection
            granularity={config.granularity}
            contextLevel={config.contextLevel}
            compress={config.compress}
            onGranularityChange={(granularity) => setConfig(prev => ({ ...prev, granularity }))}
            onContextLevelChange={(contextLevel) => setConfig(prev => ({ ...prev, contextLevel }))}
            onCompressChange={(compress) => setConfig(prev => ({ ...prev, compress }))}
          />

          {/* Cost Preview Section */}
          <CostPreviewSection
            preview={preview}
            isExporting={isExporting}
            canExport={!!(config.prompt.trim() && config.baseBranch)}
            onExport={handleExportContext}
          />

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

        {/* Sticky Footer with Generate Button */}
        <div className="sticky bottom-0 bg-white border-t border-gray-200 p-4 rounded-b-xl">
          <GenerateButton
            isGenerating={isGenerating}
            isPreviewLoading={preview.isLoading}
            isRepoLoading={repoInfo.isLoading}
            disabled={isGenerateDisabled}
            onClick={handleGenerate}
            costEstimate={preview.data?.stats.costEstimate}
          />
        </div>
      </div>
    </div>
  );
};

export default SetupWizard;
