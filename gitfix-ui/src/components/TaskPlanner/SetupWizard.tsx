import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  uploadAttachment,
  removeAttachment,
  generatePlan,
  getRepositoryInfo,
  abortGeneration,
  getAgents,
  createDraft,
  getRepoConfig,
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

interface Repo { name: string; enabled: boolean; baseBranch?: string; }

interface SetupWizardProps {
  draft?: PlannerDraft;
  onGenerateComplete: () => void;
  onDraftCreated?: (draftId: string) => void;
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

export const SetupWizard: React.FC<SetupWizardProps> = ({ draft, onGenerateComplete, onDraftCreated }) => {
  const navigate = useNavigate();
  const savedSettings = getPlannerSettings();
  const { addToast } = useToast();

  // Determine if this is "new draft" mode or "edit existing draft" mode
  const isNewMode = !draft;

  const [config, setConfig] = useState<PlannerConfig>({
    prompt: draft?.initial_prompt || '',
    baseBranch: '',
    granularity: savedSettings.lastGranularity,
    contextLevel: savedSettings.lastContextLevel,
    compress: false,
    files: draft?.attachments || [],
    contextRepositories: [],
    generationModel: null
  });

  // State for new draft mode
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<string>(draft?.repository || '');
  const [reposLoading, setReposLoading] = useState(isNewMode);
  const [localFiles, setLocalFiles] = useState<File[]>([]);
  const [isCreating, setIsCreating] = useState(false);

  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [availableRepos, setAvailableRepos] = useState<IndexedRepository[]>([]);
  const [repoInfo, setRepoInfo] = useState<RepoInfoState>({ isLoading: !isNewMode, branches: [], error: null });
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [branchError, setBranchError] = useState<string | null>(null);

  const handleGenerateComplete = useCallback(() => {
    addToast({ type: 'success', message: 'Plan generated successfully' });
    onGenerateComplete();
  }, [addToast, onGenerateComplete]);

  const { isGenerating, generationTrace, generationError, startPolling, setGenerationError } =
    useGenerationPolling({ draftId: draft?.draft_id || '', onComplete: handleGenerateComplete });
  const { isExporting, exportContext } = useContextExport(setError);

  const { preview, isContextStale, fetchPreview, clearCountdown } =
    useContextRefresh({ draftId: draft?.draft_id || '', config, onBranchError: setBranchError });

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

  // Load available repositories for new mode
  useEffect(() => {
    if (!isNewMode) return;
    const loadRepos = async () => {
      try {
        setReposLoading(true);
        const data = await getRepoConfig() as { repos_to_monitor?: unknown[] };
        const rawRepos = data.repos_to_monitor || [];
        const validRepos = rawRepos
          .filter((repo): repo is { name: string; enabled?: boolean; baseBranch?: string } =>
            typeof repo === 'object' && repo !== null && 'name' in repo && typeof (repo as { name: unknown }).name === 'string'
          )
          .map(repo => ({ name: repo.name, enabled: repo.enabled !== false, baseBranch: repo.baseBranch }));
        const enabledRepos = validRepos.filter(r => r.enabled);
        setRepos(enabledRepos);
        const lastRepo = savedSettings.lastRepository;
        if (lastRepo && enabledRepos.some(r => r.name === lastRepo)) setSelectedRepo(lastRepo);
        else if (enabledRepos.length > 0) setSelectedRepo(enabledRepos[0].name);
      } catch (err) {
        console.error('Failed to load repositories:', err);
        setError('Failed to load repositories');
      } finally { setReposLoading(false); }
    };
    loadRepos();
  }, [isNewMode, savedSettings.lastRepository]);

  useEffect(() => {
    if (isNewMode || !draft) return;
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
  }, [isNewMode, draft]);

  useEffect(() => {
    const repoToUse = draft?.repository || selectedRepo;
    if (!repoToUse) return;
    const loadAvailableRepos = async () => {
      try {
        const data = await getRepositoriesIndexingStatus();
        const indexedRepos: IndexedRepository[] = (data.repositories || [])
          .filter((repo: RepositoryIndexingStatus) =>
            repo.indexing_status === 'completed' && repo.full_name !== repoToUse
          )
          .map((repo: RepositoryIndexingStatus) => ({ full_name: repo.full_name, branch: repo.branch }));
        setAvailableRepos(indexedRepos);
      } catch (err) {
        console.error('Failed to load indexed repos:', err);
      }
    };
    loadAvailableRepos();
  }, [draft?.repository, selectedRepo]);

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
    const repoToSave = draft?.repository || selectedRepo;
    if (repoToSave) savePlannerSettings({ lastRepository: repoToSave });
  }, [draft?.repository, selectedRepo]);

  const handleUpload = async (file: File) => {
    setIsUploading(true);
    setError(null);
    try {
      if (isNewMode) {
        // For new mode, store files locally until draft is created
        const processedFile = file.type.startsWith('image/') ? await resizeImage(file) : file;
        setLocalFiles(prev => [...prev, processedFile]);
      } else if (draft) {
        const attachment = await uploadAttachment(draft.draft_id, file);
        setConfig(prev => ({ ...prev, files: [...prev.files, attachment] }));
      }
    } catch (err) {
      setError((err as Error).message || 'Failed to upload file');
    } finally {
      setIsUploading(false);
    }
  };

  const handleRemoveFile = async (attachmentId: string) => {
    if (!draft) return;
    try {
      await removeAttachment(draft.draft_id, attachmentId);
      setConfig(prev => ({ ...prev, files: prev.files.filter(f => f.id !== attachmentId) }));
    } catch (err) {
      setError((err as Error).message || 'Failed to remove file');
    }
  };

  const handleRemoveLocalFile = (fileIndex: number) => {
    setLocalFiles(prev => prev.filter((_, i) => i !== fileIndex));
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
    if (!draft) return;
    exportContext({
      draftId: draft.draft_id, prompt: config.prompt, baseBranch: config.baseBranch,
      granularity: config.granularity, contextLevel: config.contextLevel, compress: config.compress, files: config.files
    });
  }, [exportContext, draft, config]);

  const handleCreateDraftAndGenerate = async () => {
    if (!selectedRepo || !config.prompt.trim()) {
      setError('Please select a repository and enter a prompt');
      return;
    }
    setIsCreating(true);
    setError(null);
    try {
      const newDraft = await createDraft(selectedRepo, config.prompt.trim());
      // Upload any local files
      for (const file of localFiles) {
        try { await uploadAttachment(newDraft.draft_id, file); }
        catch (uploadErr) { console.error('Failed to upload attachment:', uploadErr); }
      }
      if (onDraftCreated) onDraftCreated(newDraft.draft_id);
      navigate(`/studio/${newDraft.draft_id}`, { replace: true });
    } catch (err) {
      setError((err as Error).message || 'Failed to create draft');
      setIsCreating(false);
    }
  };

  const handleGenerate = async () => {
    // For new mode, create draft first and navigate
    if (isNewMode) {
      await handleCreateDraftAndGenerate();
      return;
    }
    if (!draft) return;
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
    if (!draft) return;
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

  const isGenerateDisabled = isNewMode
    ? (isCreating || !selectedRepo || !config.prompt.trim() || reposLoading)
    : (isGenerating || !!branchError || repoInfo.isLoading || !config.prompt.trim());
  const canExport = !isNewMode && !!(config.prompt.trim() && config.baseBranch);

  // Suppress unused variable warning for availableRepos (used for future context repos feature)
  void availableRepos;

  return (
    <div className="h-full flex flex-col bg-white">
      <div className="flex-1 flex min-h-0">
        <SetupWizardLeftPane
          isNewMode={isNewMode}
          repository={draft?.repository || selectedRepo}
          repos={repos}
          selectedRepo={selectedRepo}
          onRepoChange={setSelectedRepo}
          reposLoading={reposLoading}
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
          localFiles={localFiles}
          onRemoveFile={handleRemoveFile}
          onRemoveLocalFile={handleRemoveLocalFile}
          isUploading={isUploading}
          fileInputRef={fileInputRef}
          onFileInputChange={handleFileInputChange}
          smartSelection={preview.data?.smartSelection}
          isPreviewLoading={preview.isLoading}
          hasPreviewData={!!preview.data}
          error={error}
          generationError={generationError}
          isGenerating={isGenerating}
          isCreating={isCreating}
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
          isNewMode={isNewMode}
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
