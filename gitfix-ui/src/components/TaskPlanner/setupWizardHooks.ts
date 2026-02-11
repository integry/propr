import { useState, useEffect, useCallback } from 'react';
import {
  uploadAttachment,
  removeAttachment,
  generatePlan,
  getRepositoryInfo,
  abortGeneration,
  getAgents,
  getRepoConfig,
  getRepoBranches,
  PlannerDraft,
  PlannerAttachment,
  AgentConfig
} from '../../api/gitfixApi';
import { getRepositoriesIndexingStatus, RepositoryIndexingStatus } from '../../api/repoIndexingApi';
import { savePlannerSettings } from '../../hooks/usePlannerSettings';
import { resizeImage } from './imageUtils';
import { IndexedRepository } from './ContextRepositoriesSection';

interface Repo { name: string; enabled: boolean; baseBranch?: string; }

import type { Granularity } from '../../api/gitfixApi';

export interface PlannerConfig {
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

// Helper to load repositories
async function loadRepositories(savedLastRepository: string | undefined): Promise<{ repos: Repo[]; selectedRepo: string }> {
  const data = await getRepoConfig() as { repos_to_monitor?: unknown[] };
  const rawRepos = data.repos_to_monitor || [];
  const validRepos = rawRepos
    .filter((repo): repo is { name: string; enabled?: boolean; baseBranch?: string } =>
      typeof repo === 'object' && repo !== null && 'name' in repo && typeof (repo as { name: unknown }).name === 'string'
    )
    .map(repo => ({ name: repo.name, enabled: repo.enabled !== false, baseBranch: repo.baseBranch }));
  const enabledRepos = validRepos.filter(r => r.enabled);
  let selectedRepo = '';
  if (savedLastRepository && enabledRepos.some(r => r.name === savedLastRepository)) {
    selectedRepo = savedLastRepository;
  } else if (enabledRepos.length > 0) {
    selectedRepo = enabledRepos[0].name;
  }
  return { repos: enabledRepos, selectedRepo };
}

// Helper to load indexed repos for context
async function loadIndexedRepositories(repoToExclude: string): Promise<IndexedRepository[]> {
  const data = await getRepositoriesIndexingStatus();
  return (data.repositories || [])
    .filter((repo: RepositoryIndexingStatus) =>
      repo.indexing_status === 'completed' && repo.full_name !== repoToExclude
    )
    .map((repo: RepositoryIndexingStatus) => ({ full_name: repo.full_name, branch: repo.branch }));
}

// Helper to process uploaded file (handles image resize)
async function processFileForUpload(file: File): Promise<File> {
  return file.type.startsWith('image/') ? resizeImage(file) : file;
}

// Hook: Load available repositories (for both new and edit modes)
export function useRepositoryLoader(shouldLoad: boolean, savedLastRepository: string | undefined) {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<string>('');
  const [reposLoading, setReposLoading] = useState(shouldLoad);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!shouldLoad) return;
    setReposLoading(true);
    loadRepositories(savedLastRepository)
      .then(({ repos: loadedRepos, selectedRepo: defaultRepo }) => {
        setRepos(loadedRepos);
        setSelectedRepo(defaultRepo);
      })
      .catch((err) => {
        console.error('Failed to load repositories:', err);
        setLoadError('Failed to load repositories');
      })
      .finally(() => setReposLoading(false));
  }, [shouldLoad, savedLastRepository]);

  return { repos, selectedRepo, setSelectedRepo, reposLoading, loadError };
}

// Hook: Load branches for selected repo (for new mode)
export function useBranchesLoader(selectedRepo: string, setConfig: React.Dispatch<React.SetStateAction<PlannerConfig>>) {
  const [branchesState, setBranchesState] = useState<RepoInfoState>({ isLoading: false, branches: [], error: null });

  useEffect(() => {
    if (!selectedRepo) {
      setBranchesState({ isLoading: false, branches: [], error: null });
      return;
    }

    const [owner, repo] = selectedRepo.split('/');
    if (!owner || !repo) {
      setBranchesState({ isLoading: false, branches: [], error: 'Invalid repository format' });
      return;
    }

    setBranchesState(prev => ({ ...prev, isLoading: true, error: null }));
    getRepoBranches(owner, repo)
      .then((data) => {
        setBranchesState({ isLoading: false, branches: data.branches, error: null });
        // Set the default branch when repo changes
        setConfig(prev => ({ ...prev, baseBranch: data.defaultBranch }));
      })
      .catch((err) => {
        console.error('Failed to load branches:', err);
        setBranchesState({ isLoading: false, branches: [], error: (err as Error).message });
        // Fallback to 'main' if fetching fails
        setConfig(prev => ({ ...prev, baseBranch: 'main' }));
      });
  }, [selectedRepo, setConfig]);

  return branchesState;
}

// Hook: Load repository info (for edit mode)
export function useRepoInfoLoader(isNewMode: boolean, draft: PlannerDraft | undefined, setConfig: React.Dispatch<React.SetStateAction<PlannerConfig>>) {
  const [repoInfo, setRepoInfo] = useState<RepoInfoState>({ isLoading: !isNewMode, branches: [], error: null });

  useEffect(() => {
    if (isNewMode || !draft) return;
    getRepositoryInfo(draft.draft_id)
      .then((info) => {
        setRepoInfo({ isLoading: false, branches: info.branches, error: null });
        setConfig(prev => ({ ...prev, baseBranch: info.defaultBranch }));
      })
      .catch((err) => {
        setRepoInfo({ isLoading: false, branches: [], error: (err as Error).message });
        setConfig(prev => ({ ...prev, baseBranch: 'main' }));
      });
  }, [isNewMode, draft, setConfig]);

  return repoInfo;
}

// Hook: Load agents
export function useAgentsLoader() {
  const [agents, setAgents] = useState<AgentConfig[]>([]);

  useEffect(() => {
    getAgents()
      .then((data) => setAgents(data.agents || []))
      .catch((err) => console.error('Failed to load agents:', err));
  }, []);

  return agents;
}

// Hook: Load indexed repositories for context
export function useIndexedRepositoriesLoader(draftRepository: string | undefined, selectedRepo: string) {
  const [availableRepos, setAvailableRepos] = useState<IndexedRepository[]>([]);

  useEffect(() => {
    const repoToUse = draftRepository || selectedRepo;
    if (!repoToUse) return;
    loadIndexedRepositories(repoToUse)
      .then(setAvailableRepos)
      .catch((err) => console.error('Failed to load indexed repos:', err));
  }, [draftRepository, selectedRepo]);

  return availableRepos;
}

// Hook: Persist planner settings
export function usePlannerSettingsPersistence(config: PlannerConfig, draftRepository: string | undefined, selectedRepo: string) {
  useEffect(() => {
    savePlannerSettings({ lastGranularity: config.granularity, lastContextLevel: config.contextLevel });
  }, [config.granularity, config.contextLevel]);

  useEffect(() => {
    const repoToSave = draftRepository || selectedRepo;
    if (repoToSave) savePlannerSettings({ lastRepository: repoToSave });
  }, [draftRepository, selectedRepo]);
}

// Hook: File upload and handling
export function useFileHandling(
  isNewMode: boolean,
  draft: PlannerDraft | undefined,
  setConfig: React.Dispatch<React.SetStateAction<PlannerConfig>>,
  setError: React.Dispatch<React.SetStateAction<string | null>>
) {
  const [localFiles, setLocalFiles] = useState<File[]>([]);
  const [isUploading, setIsUploading] = useState<boolean>(false);

  const handleUpload = useCallback(async (file: File) => {
    setIsUploading(true);
    setError(null);
    try {
      const processedFile = await processFileForUpload(file);
      if (isNewMode) {
        setLocalFiles(prev => [...prev, processedFile]);
      } else if (draft) {
        const attachment = await uploadAttachment(draft.draft_id, processedFile);
        setConfig(prev => ({ ...prev, files: [...prev.files, attachment] }));
      }
    } catch (err) {
      setError((err as Error).message || 'Failed to upload file');
    } finally {
      setIsUploading(false);
    }
  }, [isNewMode, draft, setConfig, setError]);

  const handleRemoveFile = useCallback(async (attachmentId: string) => {
    if (!draft) return;
    try {
      await removeAttachment(draft.draft_id, attachmentId);
      setConfig(prev => ({ ...prev, files: prev.files.filter(f => f.id !== attachmentId) }));
    } catch (err) {
      setError((err as Error).message || 'Failed to remove file');
    }
  }, [draft, setConfig, setError]);

  const handleRemoveLocalFile = useCallback((fileIndex: number) => {
    setLocalFiles(prev => prev.filter((_, i) => i !== fileIndex));
  }, []);

  const handlePaste = useCallback(async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const imageItem = Array.from(e.clipboardData?.items || []).find(item => item.type.startsWith('image/'));
    if (!imageItem) return;

    e.preventDefault();
    const blob = imageItem.getAsFile();
    if (!blob) return;

    const file = new File([blob], `pasted-image-${Date.now()}.png`, { type: blob.type });
    try {
      const processedFile = await resizeImage(file);
      await handleUpload(processedFile);
    } catch (err) {
      setError('Failed to process pasted image');
      console.error('Paste error:', err);
    }
  }, [handleUpload, setError]);

  return { localFiles, isUploading, handleUpload, handleRemoveFile, handleRemoveLocalFile, handlePaste };
}

// Hook: Generation handling
interface GenerationHandlersParams {
  draft: PlannerDraft | undefined;
  config: PlannerConfig;
  branchError: string | null;
  contextHelpers: { isContextStale: boolean; clearCountdown: () => void; fetchPreview: () => Promise<void> };
  startPolling: () => void;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  setGenerationError: (error: string | null) => void;
}

export function useGenerationHandlers({ draft, config, branchError, contextHelpers, startPolling, setError, setGenerationError }: GenerationHandlersParams) {
  const { isContextStale, clearCountdown, fetchPreview } = contextHelpers;

  const handleGenerateForExistingDraft = useCallback(async () => {
    if (!draft) return;
    if (branchError) {
      setError('Please fix the branch name before generating');
      return;
    }
    setError(null);
    setGenerationError(null);
    try {
      if (isContextStale) {
        clearCountdown();
        await fetchPreview();
      }
      await generatePlan(draft.draft_id, {
        baseBranch: config.baseBranch,
        granularity: config.granularity,
        contextLevel: config.contextLevel,
        compress: config.compress,
        contextRepositories: config.contextRepositories,
        generationModel: config.generationModel || undefined
      });
      startPolling();
    } catch (err) {
      setError((err as Error).message || 'Failed to start plan generation');
    }
  }, [draft, config, branchError, isContextStale, clearCountdown, fetchPreview, startPolling, setError, setGenerationError]);

  const handleAbortGeneration = useCallback(async () => {
    if (!draft) return;
    try {
      await abortGeneration(draft.draft_id);
    } catch (err) {
      setError((err as Error).message || 'Failed to abort generation');
    }
  }, [draft, setError]);

  return { handleGenerateForExistingDraft, handleAbortGeneration };
}

// Hook: Draft creation and upload for new mode
interface DraftCreationParams {
  selectedRepo: string;
  config: PlannerConfig;
  localFiles: File[];
  onDraftCreated?: (draftId: string) => void;
  navigate: (path: string, options?: { replace?: boolean }) => void;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  setIsCreating: React.Dispatch<React.SetStateAction<boolean>>;
}

export function useDraftCreation({ selectedRepo, config, localFiles, onDraftCreated, navigate, setError, setIsCreating }: DraftCreationParams) {
  const handleCreateDraftAndGenerate = useCallback(async () => {
    if (!selectedRepo || !config.prompt.trim()) {
      setError('Please select a repository and enter a prompt');
      return;
    }
    setIsCreating(true);
    setError(null);
    try {
      const { createDraft } = await import('../../api/gitfixApi');
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
  }, [selectedRepo, config.prompt, localFiles, onDraftCreated, navigate, setError, setIsCreating]);

  return handleCreateDraftAndGenerate;
}

// Compute isGenerateDisabled
interface GenerateDisabledParams {
  isNewMode: boolean;
  isCreating: boolean;
  selectedRepo: string;
  promptTrimmed: string;
  reposLoading: boolean;
  isGenerating: boolean;
  branchError: string | null;
  repoInfoLoading: boolean;
}

export function computeIsGenerateDisabled(params: GenerateDisabledParams): boolean {
  const { isNewMode, isCreating, selectedRepo, promptTrimmed, reposLoading, isGenerating, branchError, repoInfoLoading } = params;
  if (isNewMode) {
    return isCreating || !selectedRepo || !promptTrimmed || reposLoading;
  }
  return isGenerating || !!branchError || repoInfoLoading || !promptTrimmed;
}

// Compute canExport
export function computeCanExport(isNewMode: boolean, promptTrimmed: string, baseBranch: string): boolean {
  return !isNewMode && !!(promptTrimmed && baseBranch);
}

// Hook: Auto resize textarea
export function useAutoResize(textareaRef: React.RefObject<HTMLTextAreaElement | null>) {
  return useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.max(textarea.scrollHeight, 160)}px`;
    }
  }, [textareaRef]);
}

