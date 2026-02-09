import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  uploadAttachment,
  removeAttachment,
  generatePlan,
  getRepositoryInfo,
  abortGeneration,
  getAgents,
  PlannerDraft,
  PlannerAttachment,
  Granularity,
  AgentConfig
} from '../../api/gitfixApi';
import { getRepositoriesIndexingStatus, RepositoryIndexingStatus } from '../../api/repoIndexingApi';
import { getPlannerSettings, savePlannerSettings } from '../../hooks/usePlannerSettings';
import { useGenerationPolling } from '../../hooks/useGenerationPolling';
import { useContextExport } from '../../hooks/useContextExport';
import { useContextRefresh } from '../../hooks/useContextRefresh';
import { useToast } from '../ui/useToast';
import { resizeImage } from './imageUtils';
import { IndexedRepository } from './ContextRepositoriesSection';
import { ChevronDown, Paperclip, Loader2, Sparkles, Download } from 'lucide-react';
import { ContextLevelSlider } from './ContextLevelSlider';
import { GranularityPills, AttachmentChip } from './ComposerControls';
import { GenerationProgress } from './GenerationProgress';
import { SmartFileSelection } from './SmartFileSelection';
import { FileSelectionSkeleton } from './SkeletonLoader';

interface SetupWizardProps {
  draft: PlannerDraft;
  onGenerateComplete: () => void;
}

interface PlannerConfig {
  prompt: string;
  baseBranch: string;
  granularity: Granularity;
  contextLevel: number;
  compress: boolean;
  files: PlannerAttachment[];
  contextRepositories: { repository: string; branch?: string }[];
  /** Model selection for plan generation (format: "agent:modelId" or just "modelAlias") */
  generationModel: string | null;
}

interface RepoInfoState {
  isLoading: boolean;
  branches: string[];
  error: string | null;
}

export const SetupWizard: React.FC<SetupWizardProps> = ({ draft, onGenerateComplete }) => {
  const savedSettings = getPlannerSettings();
  const { addToast } = useToast();

  const [config, setConfig] = useState<PlannerConfig>({
    prompt: draft.initial_prompt || '',
    baseBranch: '',
    granularity: savedSettings.lastGranularity,
    contextLevel: savedSettings.lastContextLevel,
    compress: false,
    files: draft.attachments || [],
    contextRepositories: [],
    generationModel: null
  });

  const [agents, setAgents] = useState<AgentConfig[]>([]);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_availableRepos, setAvailableRepos] = useState<IndexedRepository[]>([]);
  const [repoInfo, setRepoInfo] = useState<RepoInfoState>({ isLoading: true, branches: [], error: null });
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [branchError, setBranchError] = useState<string | null>(null);

  // Wrap onGenerateComplete to show success toast
  const handleGenerateComplete = useCallback(() => {
    addToast({
      type: 'success',
      message: 'Plan generated successfully',
    });
    onGenerateComplete();
  }, [addToast, onGenerateComplete]);

  const { isGenerating, generationTrace, generationError, startPolling, setGenerationError } =
    useGenerationPolling({ draftId: draft.draft_id, onComplete: handleGenerateComplete });
  const { isExporting, exportContext } = useContextExport(setError);

  const { preview, isContextStale, fetchPreview, clearCountdown } =
    useContextRefresh({ draftId: draft.draft_id, config, onBranchError: setBranchError });

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const autoResize = useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.max(textarea.scrollHeight, 160)}px`;
    }
  }, []);

  useEffect(() => { autoResize(); }, [config.prompt, autoResize]);

  // Watch for generation errors and show error toast
  useEffect(() => {
    if (generationError) {
      addToast({
        type: 'error',
        message: `Plan generation failed: ${generationError}`,
      });
    }
  }, [generationError, addToast]);

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

  useEffect(() => {
    const loadAvailableRepos = async () => {
      try {
        const data = await getRepositoriesIndexingStatus();
        const indexedRepos: IndexedRepository[] = (data.repositories || [])
          .filter((repo: RepositoryIndexingStatus) =>
            repo.indexing_status === 'completed' && repo.full_name !== draft.repository
          )
          .map((repo: RepositoryIndexingStatus) => ({ full_name: repo.full_name, branch: repo.branch }));
        setAvailableRepos(indexedRepos);
      } catch (err) {
        console.error('Failed to load indexed repos:', err);
      }
    };
    loadAvailableRepos();
  }, [draft.repository]);

  // Fetch available agents for model selection
  useEffect(() => {
    const loadAgents = async () => {
      try {
        const data = await getAgents();
        setAgents(data.agents || []);
      } catch (err) {
        console.error('Failed to load agents:', err);
      }
    };
    loadAgents();
  }, []);

  useEffect(() => {
    savePlannerSettings({ lastGranularity: config.granularity, lastContextLevel: config.contextLevel });
  }, [config.granularity, config.contextLevel]);

  useEffect(() => {
    if (draft.repository) savePlannerSettings({ lastRepository: draft.repository });
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
        const file = new File([blob], `pasted-image-${Date.now()}.png`, { type: blob.type });
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
      draftId: draft.draft_id, prompt: config.prompt, baseBranch: config.baseBranch,
      granularity: config.granularity, contextLevel: config.contextLevel, compress: config.compress, files: config.files
    });
  }, [exportContext, draft.draft_id, config]);

  const handleGenerate = async () => {
    if (branchError) { setError('Please fix the branch name before generating'); return; }
    setError(null);
    setGenerationError(null);
    try {
      if (isContextStale) { clearCountdown(); await fetchPreview(); }
      await generatePlan(draft.draft_id, {
        baseBranch: config.baseBranch, granularity: config.granularity, contextLevel: config.contextLevel,
        compress: config.compress, contextRepositories: config.contextRepositories,
        generationModel: config.generationModel || undefined
      });
      startPolling();
    } catch (err) {
      setError((err as Error).message || 'Failed to start plan generation');
    }
  };

  const handleAbortGeneration = async () => {
    try {
      await abortGeneration(draft.draft_id);
      // The polling will detect the status change and update UI
    } catch (err) {
      setError((err as Error).message || 'Failed to abort generation');
    }
  };

  const isGenerateDisabled = isGenerating || !!branchError || repoInfo.isLoading || !config.prompt.trim();

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const processedFile = file.type.startsWith('image/') ? await resizeImage(file) : file;
      await handleUpload(processedFile);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const canExport = !!(config.prompt.trim() && config.baseBranch);

  return (
    <div className="h-full flex flex-col bg-white">
      <div className="flex-1 flex min-h-0">
        {/* Left Pane - 65% */}
        <div className="w-[65%] h-full flex flex-col border-r border-gray-100">
          {/* Header with repo/branch */}
          <div className="px-6 py-3 border-b border-gray-100">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-medium text-gray-700">{draft.repository}</span>
              <span className="text-gray-400">&gt;</span>
              <div className="relative inline-flex items-center">
                {repoInfo.isLoading ? (
                  <span className="text-gray-400">Loading...</span>
                ) : (
                  <>
                    <select
                      value={config.baseBranch}
                      onChange={(e) => setConfig(prev => ({ ...prev, baseBranch: e.target.value }))}
                      className="appearance-none bg-transparent text-gray-600 hover:text-gray-900 focus:outline-none cursor-pointer pr-5"
                      disabled={repoInfo.branches.length === 0}
                    >
                      {repoInfo.branches.length === 0 ? (
                        <option value="">No branches</option>
                      ) : (
                        repoInfo.branches.map(branch => (
                          <option key={branch} value={branch}>{branch}</option>
                        ))
                      )}
                    </select>
                    <ChevronDown className="w-3.5 h-3.5 text-gray-400 absolute right-0 pointer-events-none" />
                  </>
                )}
              </div>
              {(branchError || repoInfo.error) && (
                <span className="text-red-500 text-xs ml-2">{branchError || repoInfo.error}</span>
              )}
            </div>
          </div>

          {/* Main content area */}
          <div className="flex-1 flex flex-col p-6 min-h-0 overflow-auto">
            <div className="flex-1 flex flex-col min-h-0">
              {/* Prompt textarea */}
              <div className="flex-1 min-h-0 flex flex-col" style={{ maxHeight: '60%' }}>
                <textarea
                  ref={textareaRef}
                  value={config.prompt}
                  onChange={(e) => setConfig(prev => ({ ...prev, prompt: e.target.value }))}
                  onInput={autoResize}
                  onPaste={handlePaste}
                  placeholder="Describe the feature, bug fix, or improvement you want to implement..."
                  className="flex-1 w-full text-base text-gray-900 placeholder-gray-400 resize-none focus:outline-none leading-relaxed"
                  style={{ minHeight: '160px' }}
                />
              </div>

              {/* Attachments section */}
              <div className="mt-4 space-y-3">
                {config.files.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {config.files.map((attachment) => (
                      <AttachmentChip
                        key={attachment.id}
                        file={{ name: attachment.originalName, type: attachment.mimeType || 'application/octet-stream' } as File}
                        onRemove={() => handleRemoveFile(attachment.id)}
                      />
                    ))}
                  </div>
                )}
                <div className="flex items-center">
                  <input
                    type="file"
                    ref={fileInputRef}
                    onChange={handleFileInputChange}
                    className="hidden"
                    accept="image/*,.log,.txt,.json"
                  />
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isUploading}
                    className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700 transition-colors"
                  >
                    {isUploading ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span>Uploading...</span>
                      </>
                    ) : (
                      <>
                        <Paperclip className="w-4 h-4" />
                        <span>Attach</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Smart file selection preview */}
              <div className="mt-6">
                {preview.isLoading && !preview.data ? (
                  <FileSelectionSkeleton />
                ) : preview.data?.smartSelection && (
                  <SmartFileSelection smartSelection={preview.data.smartSelection} />
                )}
              </div>
            </div>
          </div>

          {/* Footer with error, generation progress, and actions */}
          <div className="border-t border-gray-100 bg-white">
            {/* Error display */}
            {(error || generationError) && (
              <div className="px-6 py-3 bg-red-50 border-b border-red-200 text-red-700 text-sm">
                {error || generationError}
              </div>
            )}

            {/* Generation Progress */}
            {isGenerating && (
              <div className="px-6 py-3 border-b border-gray-100">
                <GenerationProgress trace={generationTrace} onAbort={handleAbortGeneration} />
              </div>
            )}

            {/* Action bar */}
            <div className="px-6 py-4">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <span className="text-sm text-gray-500">Granularity:</span>
                  <GranularityPills
                    value={config.granularity}
                    onChange={(granularity) => setConfig(prev => ({ ...prev, granularity }))}
                  />
                </div>
                <div className="flex items-center gap-3">
                  {/* Export Context Button */}
                  <button
                    onClick={handleExportContext}
                    disabled={isExporting || preview.isLoading || !canExport}
                    className="flex items-center gap-2 px-4 py-2 text-gray-600 hover:text-gray-900 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
                    title="Export context as file"
                  >
                    {isExporting ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Download className="w-4 h-4" />
                    )}
                    <span>Export</span>
                  </button>

                  {/* Generate Plan Button */}
                  <button
                    onClick={handleGenerate}
                    disabled={isGenerateDisabled}
                    className="flex items-center gap-2 px-6 py-2.5 bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
                  >
                    {isGenerating ? (
                      <>
                        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                        <span>Generating...</span>
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-4 h-4" />
                        <span>Generate Plan</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right Pane - 35% */}
        <div className="w-[35%] h-full flex flex-col bg-white">
          {/* Context Level Slider */}
          <div className="p-5 border-b border-gray-100">
            <ContextLevelSlider
              value={config.contextLevel}
              onChange={(contextLevel) => setConfig(prev => ({ ...prev, contextLevel }))}
              compress={config.compress}
              onCompressChange={(compress) => setConfig(prev => ({ ...prev, compress }))}
              agents={agents}
              generationModel={config.generationModel}
              onGenerationModelChange={(generationModel) => setConfig(prev => ({ ...prev, generationModel }))}
              modelName={preview.data?.stats.modelName}
              modelMaxContextTokens={preview.data?.stats.modelMaxContextTokens}
            />
          </div>

          {/* Selected files / Cost preview area */}
          <div className="flex-1 overflow-auto p-5">
            <div className="space-y-3">
              <h3 className="text-sm font-medium text-gray-700">
                Selected Files ({preview.data?.smartSelection?.length || 0})
              </h3>
              {preview.isLoading ? (
                <p className="text-sm text-gray-400 italic">Analyzing context...</p>
              ) : preview.data?.smartSelection?.length ? (
                <div className="text-sm text-gray-600 space-y-1 max-h-64 overflow-auto">
                  {preview.data.smartSelection.slice(0, 10).map((file, i) => (
                    <div key={i} className="truncate text-xs text-gray-500">{file.path}</div>
                  ))}
                  {preview.data.smartSelection.length > 10 && (
                    <div className="text-xs text-gray-400 italic">
                      +{preview.data.smartSelection.length - 10} more files
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm text-gray-400 italic">
                  Enter a prompt to analyze relevant files
                </p>
              )}
            </div>
          </div>

          {/* Cost estimate footer */}
          <div className="border-t border-gray-100 px-5 py-4 bg-white">
            <div className="flex items-center justify-between text-sm">
              <div className="text-gray-500">
                <span className="font-medium text-gray-700">
                  {preview.data?.stats.totalTokens
                    ? (preview.data.stats.totalTokens / 1000).toFixed(0)
                    : '0'}k
                </span>{' '}
                tokens
              </div>
              <div className="text-gray-600">
                Est:{' '}
                <span className="font-semibold text-gray-900">
                  ${preview.data?.stats.costEstimate?.toFixed(2) || '0.00'}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SetupWizard;
