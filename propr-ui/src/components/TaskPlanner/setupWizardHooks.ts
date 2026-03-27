import { useState, useEffect, useCallback, useRef } from 'react';
import {
  uploadAttachment,
  removeAttachment,
  generatePlan,
  getRepositoryInfo,
  abortGeneration,
  getAgents,
  getRepoConfig,
  getRepoBranches,
  updateDraft,
  PlannerDraft,
  PlannerAttachment,
  AgentConfig
} from '../../api/proprApi';
import { getRepositoriesIndexingStatus, RepositoryIndexingStatus } from '../../api/repoIndexingApi';
import { savePlannerSettings } from '../../hooks/usePlannerSettings';
import { resizeImage } from './imageUtils';
import { IndexedRepository } from './ContextRepositoriesSection';
import { constructDraftWithPlan } from './useAutoDraftCreation';
export { useAutoDraftCreation, constructDraftWithPlan } from './useAutoDraftCreation';

interface Repo { name: string; enabled: boolean; baseBranch?: string; }

import type { Granularity } from '../../api/proprApi';

export interface PlannerConfig {
  prompt: string;
  baseBranch: string;
  granularity: Granularity;
  contextLevel: number;
  compress: boolean;
  files: PlannerAttachment[];
  contextRepositories: { repository: string; branch?: string }[];
  generationModel: string | null;
  /** File paths explicitly added by the user to include in context */
  manualFiles: string[];
  excludedFiles: string[];
}

interface RepoInfoState {
  isLoading: boolean;
  branches: string[];
  error: string | null;
}

async function loadRepositories(savedLastRepository: string | undefined): Promise<{ repos: Repo[]; selectedRepo: string }> {
  const data = await getRepoConfig() as { repos_to_monitor?: unknown[] };
  const validRepos = (data.repos_to_monitor || [])
    .filter((r): r is { name: string; enabled?: boolean; baseBranch?: string } => typeof r === 'object' && r !== null && 'name' in r && typeof (r as { name: unknown }).name === 'string')
    .map(r => ({ name: r.name, enabled: r.enabled !== false, baseBranch: r.baseBranch }));
  const enabledRepos = validRepos.filter(r => r.enabled);
  const selectedRepo = (savedLastRepository && enabledRepos.some(r => r.name === savedLastRepository)) ? savedLastRepository : (enabledRepos[0]?.name || '');
  return { repos: enabledRepos, selectedRepo };
}

async function loadIndexedRepositories(repoToExclude: string): Promise<IndexedRepository[]> {
  const data = await getRepositoriesIndexingStatus();
  return (data.repositories || [])
    .filter((r: RepositoryIndexingStatus) => (r.indexing_status === 'completed' || r.indexing_status === 'indexing') && r.full_name !== repoToExclude)
    .map((r: RepositoryIndexingStatus) => ({ full_name: r.full_name, branch: r.branch, indexing_status: r.indexing_status }));
}

async function processFileForUpload(file: File): Promise<File> { return file.type.startsWith('image/') ? resizeImage(file) : file; }

export function useRepositoryLoader(shouldLoad: boolean, savedLastRepository: string | undefined) {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<string>('');
  const [reposLoading, setReposLoading] = useState(shouldLoad);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    if (!shouldLoad) return;
    setReposLoading(true);
    loadRepositories(savedLastRepository).then(({ repos: loadedRepos, selectedRepo: defaultRepo }) => {
      setRepos(loadedRepos); setSelectedRepo(defaultRepo);
    }).catch(err => { console.error('Failed to load repositories:', err); setLoadError('Failed to load repositories'); }).finally(() => setReposLoading(false));
  }, [shouldLoad, savedLastRepository]);
  return { repos, selectedRepo, setSelectedRepo, reposLoading, loadError };
}

export function useBranchesLoader(selectedRepo: string, setConfig: React.Dispatch<React.SetStateAction<PlannerConfig>>) {
  const [branchesState, setBranchesState] = useState<RepoInfoState>({ isLoading: false, branches: [], error: null });
  useEffect(() => {
    if (!selectedRepo) { setBranchesState({ isLoading: false, branches: [], error: null }); return; }
    const [owner, repo] = selectedRepo.split('/');
    if (!owner || !repo) { setBranchesState({ isLoading: false, branches: [], error: 'Invalid repository format' }); return; }
    setBranchesState(prev => ({ ...prev, isLoading: true, error: null }));
    getRepoBranches(owner, repo).then(data => {
      setBranchesState({ isLoading: false, branches: data.branches, error: null });
      setConfig(prev => ({ ...prev, baseBranch: data.defaultBranch }));
    }).catch(err => {
      console.error('Failed to load branches:', err);
      setBranchesState({ isLoading: false, branches: [], error: (err as Error).message });
      setConfig(prev => ({ ...prev, baseBranch: 'main' }));
    });
  }, [selectedRepo, setConfig]);
  return branchesState;
}

export function useRepoInfoLoader(isNewMode: boolean, draft: PlannerDraft | undefined, setConfig: React.Dispatch<React.SetStateAction<PlannerConfig>>) {
  const [repoInfo, setRepoInfo] = useState<RepoInfoState>({ isLoading: !isNewMode, branches: [], error: null });
  useEffect(() => {
    if (isNewMode || !draft) return;
    getRepositoryInfo(draft.draft_id).then(info => {
      setRepoInfo({ isLoading: false, branches: info.branches, error: null });
      setConfig(prev => ({ ...prev, baseBranch: info.defaultBranch }));
    }).catch(err => {
      setRepoInfo({ isLoading: false, branches: [], error: (err as Error).message });
      setConfig(prev => ({ ...prev, baseBranch: 'main' }));
    });
  }, [isNewMode, draft, setConfig]);
  return repoInfo;
}

export function useAgentsLoader() {
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  useEffect(() => { getAgents().then(data => setAgents(data.agents || [])).catch(err => console.error('Failed to load agents:', err)); }, []);
  return agents;
}

export function useIndexedRepositoriesLoader(draftRepository: string | undefined, selectedRepo: string) {
  const [availableRepos, setAvailableRepos] = useState<IndexedRepository[]>([]);
  useEffect(() => {
    const repo = draftRepository || selectedRepo;
    if (repo) loadIndexedRepositories(repo).then(setAvailableRepos).catch(err => console.error('Failed to load indexed repos:', err));
  }, [draftRepository, selectedRepo]);
  return availableRepos;
}

export function usePlannerSettingsPersistence(config: PlannerConfig, draftRepository: string | undefined, selectedRepo: string) {
  useEffect(() => { savePlannerSettings({ lastGranularity: config.granularity, lastContextLevel: config.contextLevel }); }, [config.granularity, config.contextLevel]);
  useEffect(() => { const repo = draftRepository || selectedRepo; if (repo) savePlannerSettings({ lastRepository: repo }); }, [draftRepository, selectedRepo]);
}

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

interface GenerationHandlersParams {
  draft: PlannerDraft | undefined; config: PlannerConfig; branchError: string | null;
  contextHelpers: { isContextStale: boolean; clearCountdown: () => void; fetchPreview: () => Promise<void> };
  startPolling: () => void; stopPolling: () => void;
  setError: React.Dispatch<React.SetStateAction<string | null>>; setGenerationError: (error: string | null) => void;
}

export function useGenerationHandlers({ draft, config, branchError, contextHelpers, startPolling, stopPolling, setError, setGenerationError }: GenerationHandlersParams) {
  const handleGenerateForExistingDraft = useCallback(async () => {
    if (!draft) return;
    if (branchError) {
      setError('Please fix the branch name before generating');
      return;
    }
    setError(null);
    setGenerationError(null);
    startPolling(); // Start polling immediately to show loading state
    try {
      if (contextHelpers.isContextStale) { contextHelpers.clearCountdown(); await contextHelpers.fetchPreview(); }
      await generatePlan(draft.draft_id, {
        baseBranch: config.baseBranch,
        granularity: config.granularity,
        contextLevel: config.contextLevel,
        compress: config.compress,
        contextRepositories: config.contextRepositories,
        generationModel: config.generationModel || undefined,
        excludedFiles: config.excludedFiles.length > 0 ? config.excludedFiles : undefined
      });
    } catch (err) {
      stopPolling();
      setError((err as Error).message || 'Failed to start plan generation');
    }
  }, [draft, config, branchError, contextHelpers, startPolling, stopPolling, setError, setGenerationError]);

  const handleAbortGeneration = useCallback(async () => {
    if (!draft) return;
    try {
      await abortGeneration(draft.draft_id);
      stopPolling();
    } catch (err) {
      setError((err as Error).message || 'Failed to abort generation');
    }
  }, [draft, stopPolling, setError]);

  return { handleGenerateForExistingDraft, handleAbortGeneration };
}

interface DraftCreationParams {
  selectedRepo: string; config: PlannerConfig; localFiles: File[];
  onDraftCreated?: (draftId: string) => void;
  navigate: (path: string, options?: { replace?: boolean; state?: unknown }) => void;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  setIsCreating: React.Dispatch<React.SetStateAction<boolean>>;
  /** Optional array of to-do IDs to link to the draft */
  todoIds?: string[];
}

export function useDraftCreation({ selectedRepo, config, localFiles, onDraftCreated, navigate, setError, setIsCreating, todoIds }: DraftCreationParams) {
  const handleCreateDraftAndGenerate = useCallback(async () => {
    if (!selectedRepo || !config.prompt.trim()) {
      setError('Please select a repository and enter a prompt');
      return;
    }
    setIsCreating(true);
    setError(null);
    try {
      const { createDraft } = await import('../../api/proprApi');
      const newDraft = await createDraft(selectedRepo, config.prompt.trim(), { todoIds });
      // Upload any local files
      for (const file of localFiles) {
        try { await uploadAttachment(newDraft.draft_id, file); }
        catch (uploadErr) { console.error('Failed to upload attachment:', uploadErr); }
      }
      if (onDraftCreated) onDraftCreated(newDraft.draft_id);
      // Start plan generation immediately after draft creation
      await generatePlan(newDraft.draft_id, {
        baseBranch: config.baseBranch,
        granularity: config.granularity,
        contextLevel: config.contextLevel,
        compress: config.compress,
        contextRepositories: config.contextRepositories,
        generationModel: config.generationModel || undefined,
        excludedFiles: config.excludedFiles.length > 0 ? config.excludedFiles : undefined
      });
      // Pass the draft data via router state to avoid re-fetch and UI flicker
      // Set status to 'generating' so the UI shows the generating state immediately
      const draftWithPlan = constructDraftWithPlan(newDraft);
      draftWithPlan.status = 'generating';
      navigate(`/studio/${newDraft.draft_id}`, { replace: true, state: { initialDraft: draftWithPlan } });
    } catch (err) {
      setError((err as Error).message || 'Failed to create draft');
      setIsCreating(false);
    }
  }, [selectedRepo, config, localFiles, onDraftCreated, navigate, setError, setIsCreating, todoIds]);

  return handleCreateDraftAndGenerate;
}

interface GenerateDisabledParams {
  isNewMode: boolean; isCreating: boolean; selectedRepo: string; promptTrimmed: string;
  reposLoading: boolean; isGenerating: boolean; branchError: string | null; repoInfoLoading: boolean;
}

export function computeIsGenerateDisabled(p: GenerateDisabledParams): boolean {
  if (p.isNewMode) return p.isCreating || !p.selectedRepo || !p.promptTrimmed || p.reposLoading;
  return p.isGenerating || !!p.branchError || p.repoInfoLoading || !p.promptTrimmed;
}

export function computeCanExport(isNewMode: boolean, promptTrimmed: string, baseBranch: string): boolean {
  return !isNewMode && !!(promptTrimmed && baseBranch);
}

export function useAutoResize(textareaRef: React.RefObject<HTMLTextAreaElement | null>) {
  return useCallback(() => {
    const el = textareaRef.current;
    if (el) { el.style.height = 'auto'; el.style.height = `${Math.max(el.scrollHeight, 160)}px`; }
  }, [textareaRef]);
}

/** Truncate prompt to first 2 sentences for plan name/summary. Mirrors backend truncateToSentences. */
function truncateToSentences(text: string): string {
  const trimmed = text.trim();
  const sentencePattern = /[^.!?]+[.!?]+/g;
  const sentences: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = sentencePattern.exec(trimmed)) !== null && sentences.length < 2) {
    sentences.push(match[0].trim());
  }
  if (sentences.length > 0) return sentences.join(' ');
  if (trimmed.length <= 100) return trimmed;
  const truncated = trimmed.slice(0, 100);
  const lastSpace = truncated.lastIndexOf(' ');
  return lastSpace > 0 ? truncated.slice(0, lastSpace) + '...' : truncated + '...';
}

// Hook: Persist prompt changes to database with debounce
const PROMPT_SAVE_DEBOUNCE = 1000; // 1 second debounce

export function usePromptPersistence(
  draftId: string | undefined,
  prompt: string,
  initialPrompt: string | undefined
) {
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedPromptRef = useRef<string>(initialPrompt || '');
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    // Skip if no draft (new mode without auto-created draft yet)
    if (!draftId) return;

    // Skip if prompt hasn't changed from last saved value
    const trimmedPrompt = prompt.trim();
    if (trimmedPrompt === lastSavedPromptRef.current) return;

    // Clear any pending save
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    // Debounce the save
    debounceTimerRef.current = setTimeout(async () => {
      if (!isMountedRef.current) return;

      try {
        const name = truncateToSentences(trimmedPrompt);
        await updateDraft(draftId, { initial_prompt: trimmedPrompt, name });
        lastSavedPromptRef.current = trimmedPrompt;
      } catch (err) {
        console.error('Failed to persist prompt:', err);
      }
    }, PROMPT_SAVE_DEBOUNCE);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [draftId, prompt]);
}
