import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  uploadAttachment,
  removeAttachment,
  generatePlan,
  previewContext,
  downloadContext,
  getRepositoryInfo,
  PlannerDraft,
  PlannerAttachment,
  Granularity,
  PreviewResult
} from '../../api/gitfixApi';
import { getPlannerSettings, savePlannerSettings } from '../../hooks/usePlannerSettings';
import { useGenerationPolling } from '../../hooks/useGenerationPolling';
import { GenerationProgress } from './GenerationProgress';
import { CostPreview } from './CostPreview';
import { SmartFileSelection } from './SmartFileSelection';
import { AttachmentUploader } from './AttachmentUploader';
import { resizeImage } from './imageUtils';
import { GranularitySelector } from './GranularitySelector';
import { ContextLevelSlider } from './ContextLevelSlider';
import { BranchSelector } from './BranchSelector';
import { GenerateButton } from './GenerateButton';
import { FileSelectionSkeleton } from './SkeletonLoader';
import { Loader2, Download, GitBranch, Settings2 } from 'lucide-react';

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
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [initialSyncDone, setInitialSyncDone] = useState<boolean>(false);

  const { isGenerating, generationTrace, generationError, startPolling, setGenerationError } =
    useGenerationPolling({ draftId: draft.draft_id, onComplete: onGenerateComplete });

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const configRef = useRef(config);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  // Cleanup: abort any pending request when component unmounts
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  const autoResize = useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      // Reset height to auto to get the correct scrollHeight
      textarea.style.height = 'auto';
      // Set height to scrollHeight, with minimum of 160px (approximately 6-7 rows)
      const minHeight = 160;
      textarea.style.height = `${Math.max(textarea.scrollHeight, minHeight)}px`;
    }
  }, []);

  // Auto-resize textarea when prompt changes (handles initial content and programmatic changes)
  useEffect(() => {
    autoResize();
  }, [config.prompt, autoResize]);

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

  const handleExportContext = async () => {
    if (!config.prompt.trim() || !config.baseBranch) {
      setError('Please provide a prompt and select a branch before exporting');
      return;
    }

    setIsExporting(true);
    setError(null);

    try {
      const blob = await downloadContext({
        draftId: draft.draft_id,
        prompt: config.prompt,
        baseBranch: config.baseBranch,
        granularity: config.granularity,
        contextLevel: config.contextLevel,
        compress: config.compress,
        files: config.files.map(f => f.originalName)
      });

      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `context-${draft.draft_id}.xml`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err) {
      setError((err as Error).message || 'Failed to export context');
    } finally {
      setIsExporting(false);
    }
  };

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
      <div className="bg-slate-800 text-white rounded-t-xl px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <GitBranch className="w-5 h-5 text-slate-400" />
            <div>
              <span className="text-slate-400 text-sm">Repository</span>
              <p className="font-mono text-white">{draft.repository}</p>
            </div>
          </div>
          <BranchSelector
            value={config.baseBranch}
            branches={repoInfo.branches}
            isLoading={repoInfo.isLoading}
            error={branchError || repoInfo.error}
            onChange={(branch) => setConfig(prev => ({ ...prev, baseBranch: branch }))}
          />
        </div>
      </div>

      {/* Main content area */}
      <div className="flex-1 bg-white rounded-b-xl shadow-lg">
        <div className="p-6 space-y-6">
          {/* Hero Prompt Area */}
          <div className="space-y-3">
            <label className="block text-lg font-semibold text-gray-900">
              What would you like to build?
            </label>
            <div className="rounded-xl border-2 border-gray-200 focus-within:border-indigo-500 transition-colors overflow-hidden">
              <textarea
                ref={textareaRef}
                value={config.prompt}
                onChange={(e) => setConfig(prev => ({ ...prev, prompt: e.target.value }))}
                onInput={autoResize}
                onPaste={handlePaste}
                placeholder="Describe the feature, bug fix, or improvement you want to implement..."
                className="w-full px-5 py-4 text-base border-0 focus:ring-0 resize-none overflow-hidden"
                style={{ minHeight: '160px' }}
              />
              {/* Integrated attachment area */}
              <div className="px-4 pb-3 border-t border-gray-100 bg-gray-50">
                <AttachmentUploader
                  files={config.files}
                  draftId={draft.draft_id}
                  isUploading={isUploading}
                  onUpload={handleUpload}
                  onRemove={handleRemoveFile}
                  compact
                />
              </div>
            </div>
            <p className="text-xs text-gray-400">
              Tip: Paste screenshots directly, or drag & drop files for additional context
            </p>
          </div>

          {/* Context Settings Section */}
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-gray-700">
              <Settings2 className="w-5 h-5" />
              <h3 className="font-semibold">Context Settings</h3>
            </div>

            <div className="bg-gray-50 rounded-xl p-5 space-y-5 border border-gray-100">
              <GranularitySelector
                value={config.granularity}
                onChange={(granularity) => setConfig(prev => ({ ...prev, granularity }))}
              />

              <div className="border-t border-gray-200 pt-5">
                <ContextLevelSlider
                  value={config.contextLevel}
                  onChange={(contextLevel) => setConfig(prev => ({ ...prev, contextLevel }))}
                  compress={config.compress}
                  onCompressChange={(compress) => setConfig(prev => ({ ...prev, compress }))}
                />
              </div>
            </div>
          </div>

          {/* Cost Preview Section */}
          <div className="space-y-3">
            <CostPreview preview={preview} />

            <div className="flex justify-end">
              <button
                onClick={handleExportContext}
                disabled={isExporting || preview.isLoading || !config.prompt.trim() || !config.baseBranch}
                className="text-sm text-indigo-600 hover:text-indigo-800 font-medium flex items-center gap-1 disabled:text-gray-400 disabled:cursor-not-allowed"
              >
                {isExporting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Download className="w-4 h-4" />
                )}
                Export Context (XML)
              </button>
            </div>
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
