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
import { SetupWizardLeftPane } from './SetupWizardLeftPane';
import { SetupWizardRightPane } from './SetupWizardRightPane';

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

  const handleGenerateComplete = useCallback(() => {
    addToast({ type: 'success', message: 'Plan generated successfully' });
    onGenerateComplete();
  }, [addToast, onGenerateComplete]);

  const { isGenerating, generationTrace, generationError, startPolling, setGenerationError } =
    useGenerationPolling({ draftId: draft.draft_id, onComplete: handleGenerateComplete });
  const { isExporting, exportContext } = useContextExport(setError);

  const { preview, isContextStale, fetchPreview, clearCountdown } =
    useContextRefresh({ draftId: draft.draft_id, config, onBranchError: setBranchError });

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const autoResize = useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.max(textarea.scrollHeight, 160)}px`;
    }
  }, []);

  useEffect(() => { autoResize(); }, [config.prompt, autoResize]);

  useEffect(() => {
    if (generationError) {
      addToast({ type: 'error', message: `Plan generation failed: ${generationError}` });
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
    } catch (err) {
      setError((err as Error).message || 'Failed to abort generation');
    }
  };

  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const processedFile = file.type.startsWith('image/') ? await resizeImage(file) : file;
      await handleUpload(processedFile);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const isGenerateDisabled = isGenerating || !!branchError || repoInfo.isLoading || !config.prompt.trim();
  const canExport = !!(config.prompt.trim() && config.baseBranch);

  // Suppress unused variable warning for availableRepos (used for future context repos feature)
  void availableRepos;

  return (
    <div className="h-full flex flex-col bg-white">
      <div className="flex-1 flex min-h-0">
        <SetupWizardLeftPane
          repository={draft.repository}
          baseBranch={config.baseBranch}
          branches={repoInfo.branches}
          isRepoLoading={repoInfo.isLoading}
          branchError={branchError}
          repoError={repoInfo.error}
          onBranchChange={(branch) => setConfig(prev => ({ ...prev, baseBranch: branch }))}
          prompt={config.prompt}
          onPromptChange={(prompt) => setConfig(prev => ({ ...prev, prompt }))}
          textareaRef={textareaRef}
          autoResize={autoResize}
          onPaste={handlePaste}
          files={config.files}
          onRemoveFile={handleRemoveFile}
          isUploading={isUploading}
          fileInputRef={fileInputRef}
          onFileInputChange={handleFileInputChange}
          smartSelection={preview.data?.smartSelection}
          isPreviewLoading={preview.isLoading}
          hasPreviewData={!!preview.data}
          error={error}
          generationError={generationError}
          isGenerating={isGenerating}
          generationTrace={generationTrace}
          onAbort={handleAbortGeneration}
          granularity={config.granularity}
          onGranularityChange={(granularity) => setConfig(prev => ({ ...prev, granularity }))}
          isExporting={isExporting}
          canExport={canExport}
          onExport={handleExportContext}
          isGenerateDisabled={isGenerateDisabled}
          onGenerate={handleGenerate}
        />
        <SetupWizardRightPane
          contextLevel={config.contextLevel}
          onContextLevelChange={(contextLevel) => setConfig(prev => ({ ...prev, contextLevel }))}
          compress={config.compress}
          onCompressChange={(compress) => setConfig(prev => ({ ...prev, compress }))}
          agents={agents}
          generationModel={config.generationModel}
          onGenerationModelChange={(generationModel) => setConfig(prev => ({ ...prev, generationModel }))}
          smartSelection={preview.data?.smartSelection}
          isPreviewLoading={preview.isLoading}
          stats={preview.data?.stats}
        />
      </div>
    </div>
  );
};

export default SetupWizard;
