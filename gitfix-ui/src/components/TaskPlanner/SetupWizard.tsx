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
  ContextRepository,
  AgentConfig
} from '../../api/gitfixApi';
import { getRepositoriesIndexingStatus, RepositoryIndexingStatus } from '../../api/repoIndexingApi';
import { getPlannerSettings, savePlannerSettings } from '../../hooks/usePlannerSettings';
import { useGenerationPolling } from '../../hooks/useGenerationPolling';
import { useContextExport } from '../../hooks/useContextExport';
import { useContextRefresh } from '../../hooks/useContextRefresh';
import { useToast } from '../ui/useToast';
import { resizeImage } from './imageUtils';
import { ContextHeader } from './ContextHeader';
import { IndexedRepository } from './ContextRepositoriesSection';
import { SetupWizardContent } from './SetupWizardContent';

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
  contextRepositories: ContextRepository[];
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

  const [availableRepos, setAvailableRepos] = useState<IndexedRepository[]>([]);
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

  const { preview, isContextStale, timeUntilRefresh, isPaused, fetchPreview, handleManualRefresh, clearCountdown, togglePause } =
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

  const handleAddContextRepo = (repo: ContextRepository) => {
    setConfig(prev => ({ ...prev, contextRepositories: [...prev.contextRepositories, repo] }));
  };

  const handleRemoveContextRepo = (repository: string) => {
    setConfig(prev => ({ ...prev, contextRepositories: prev.contextRepositories.filter(r => r.repository !== repository) }));
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

  const isGenerateDisabled = isGenerating || !!branchError || repoInfo.isLoading;

  return (
    <div className="w-full h-full flex flex-col">
      <ContextHeader
        repository={draft.repository} baseBranch={config.baseBranch} branches={repoInfo.branches}
        isLoading={repoInfo.isLoading} error={branchError || repoInfo.error}
        onBranchChange={(branch) => setConfig(prev => ({ ...prev, baseBranch: branch }))}
      />
      <div className="flex-1 bg-white rounded-b-xl shadow-lg overflow-hidden">
        <SetupWizardContent
          prompt={config.prompt} files={config.files} draftId={draft.draft_id} isUploading={isUploading}
          textareaRef={textareaRef} onPromptChange={(prompt) => setConfig(prev => ({ ...prev, prompt }))}
          onInput={autoResize} onPaste={handlePaste} onUpload={handleUpload} onRemoveFile={handleRemoveFile}
          granularity={config.granularity} onGranularityChange={(granularity) => setConfig(prev => ({ ...prev, granularity }))}
          contextLevel={config.contextLevel} compress={config.compress}
          onContextLevelChange={(contextLevel) => setConfig(prev => ({ ...prev, contextLevel }))}
          onCompressChange={(compress) => setConfig(prev => ({ ...prev, compress }))}
          contextRepositories={config.contextRepositories} availableRepos={availableRepos}
          onAddContextRepo={handleAddContextRepo} onRemoveContextRepo={handleRemoveContextRepo}
          agents={agents} generationModel={config.generationModel}
          onGenerationModelChange={(generationModel) => setConfig(prev => ({ ...prev, generationModel }))}
          preview={preview} isContextStale={isContextStale} timeUntilRefresh={timeUntilRefresh}
          isPaused={isPaused} onTogglePause={togglePause}
          onManualRefresh={handleManualRefresh} error={error} generationError={generationError}
          isGenerating={isGenerating} generationTrace={generationTrace}
          onAbort={handleAbortGeneration}
          isRepoLoading={repoInfo.isLoading}
          isGenerateDisabled={isGenerateDisabled}
          onGenerate={handleGenerate}
          isExporting={isExporting}
          isPreviewLoading={preview.isLoading}
          canExport={!!(config.prompt.trim() && config.baseBranch)}
          onExport={handleExportContext}
        />
      </div>
    </div>
  );
};

export default SetupWizard;
