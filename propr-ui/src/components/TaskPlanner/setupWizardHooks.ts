import { useState, useEffect, useCallback, useRef } from 'react';
import { uploadAttachment, removeAttachment, generatePlan, abortGeneration, getAgents, getRepoConfig, getRepoBranches, updateDraft, PlannerDraft, PlannerAttachment, AgentConfig, DraftContextConfig, GenerationTrace, Granularity } from '../../api/proprApi';
import { getRepositoriesIndexingStatus, RepositoryIndexingStatus } from '../../api/repoIndexingApi';
import { getUserRepoPreferences, UserRepoPreferences } from '../../api/userRepoPreferencesApi';
import { savePlannerSettings } from '../../hooks/usePlannerSettings';
import { resizeImage } from './imageUtils';
import { IndexedRepository } from './ContextRepositoriesSection';
import { constructDraftWithPlan, getBaseBranchPersistenceWarning, persistResolvedBaseBranch } from './useAutoDraftCreation';
import type { RepoSelection } from '../RepositorySelector';
export { useAutoDraftCreation, constructDraftWithPlan, getBaseBranchPersistenceWarning, persistResolvedBaseBranch } from './useAutoDraftCreation';
export interface Repo { name: string; enabled: boolean; baseBranch?: string; starred?: boolean; iconPath?: string | null; }
export interface PlannerConfig { prompt: string; baseBranch: string; granularity: Granularity; contextLevel: number; compress: boolean; files: PlannerAttachment[];
  contextRepositories: { repository: string; branch?: string }[]; generationModel: string | null; manualFiles: string[]; excludedFiles: string[]; }

interface RepoInfoState { isLoading: boolean; error: string | null; }
const clearResolvedBaseBranch = (setConfig: React.Dispatch<React.SetStateAction<PlannerConfig>>) => setConfig(prev => prev.baseBranch ? { ...prev, baseBranch: '' } : prev);
const setResolvedBaseBranch = (setConfig: React.Dispatch<React.SetStateAction<PlannerConfig>>, baseBranch: string) => setConfig(prev => prev.baseBranch === baseBranch ? prev : { ...prev, baseBranch });

async function loadRepositories(savedLastRepository: string | undefined, savedLastBaseBranch: string | undefined): Promise<{ repos: Repo[]; selectedRepo: string; selectedBaseBranch: string }> {
  const [repoData, userPrefs, indexingData] = await Promise.all([
    getRepoConfig() as Promise<{ repos_to_monitor?: unknown[] }>,
    getUserRepoPreferences().catch(() => ({} as UserRepoPreferences)),
    getRepositoriesIndexingStatus().catch(() => ({ repositories: [] as RepositoryIndexingStatus[] }))
  ]);
  const indexingMap = new Map<string, RepositoryIndexingStatus>();
  for (const status of indexingData.repositories || []) indexingMap.set(status.full_name, status);
  const validRepos = (repoData.repos_to_monitor || [])
    .filter((r): r is { name: string; enabled?: boolean; baseBranch?: string } => typeof r === 'object' && r !== null && 'name' in r && typeof (r as { name: unknown }).name === 'string')
    .map(r => {
      const prefs = userPrefs[r.name];
      const indexingStatus = indexingMap.get(r.name);
      return {
        name: r.name,
        enabled: r.enabled !== false,
        baseBranch: r.baseBranch,
        starred: prefs?.starred || false,
        iconPath: indexingStatus?.icon_path || null
      };
    });
  const enabledRepos = validRepos.filter(r => r.enabled);
  const selectedRepoEntry = savedLastRepository
    ? enabledRepos.find(r => r.name === savedLastRepository && (r.baseBranch || '') === (savedLastBaseBranch || '')) || enabledRepos.find(r => r.name === savedLastRepository)
    : enabledRepos[0];
  return { repos: enabledRepos, selectedRepo: selectedRepoEntry?.name || '', selectedBaseBranch: selectedRepoEntry?.baseBranch || '' };
}

async function loadIndexedRepositories(repoToExclude: string): Promise<IndexedRepository[]> {
  const data = await getRepositoriesIndexingStatus();
  return (data.repositories || [])
    .filter((r: RepositoryIndexingStatus) => (r.indexing_status === 'completed' || r.indexing_status === 'indexing') && r.full_name !== repoToExclude)
    .map((r: RepositoryIndexingStatus) => ({ full_name: r.full_name, branch: r.branch, indexing_status: r.indexing_status }));
}

async function processFileForUpload(file: File): Promise<File> { return file.type.startsWith('image/') ? resizeImage(file) : file; }
function buildGenerationPayload(config: PlannerConfig) { return { baseBranch: config.baseBranch, granularity: config.granularity, contextLevel: config.contextLevel, compress: config.compress, contextRepositories: config.contextRepositories, generationModel: config.generationModel || undefined, excludedFiles: config.excludedFiles.length > 0 ? config.excludedFiles : undefined }; }

export function useRepositoryLoader(shouldLoad: boolean, savedLastRepository: string | undefined, savedLastBaseBranch: string | undefined) {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<string>('');
  const [selectedBaseBranch, setSelectedBaseBranch] = useState<string>('');
  const [reposLoading, setReposLoading] = useState(shouldLoad);
  const [loadError, setLoadError] = useState<string | null>(null);
  const setSelectedRepository = useCallback((repo: string, selection?: string | RepoSelection) => {
    setSelectedRepo(repo);
    setSelectedBaseBranch(typeof selection === 'string' ? selection : selection?.baseBranch || '');
  }, []);

  useEffect(() => {
    if (!shouldLoad) return;
    setReposLoading(true);
    loadRepositories(savedLastRepository, savedLastBaseBranch)
      .then(({ repos: loadedRepos, selectedRepo: defaultRepo, selectedBaseBranch: defaultBaseBranch }) => {
        setRepos(loadedRepos);
        setSelectedRepo(defaultRepo);
        setSelectedBaseBranch(defaultBaseBranch);
      })
      .catch(err => { console.error('Failed to load repositories:', err); setLoadError('Failed to load repositories'); })
      .finally(() => setReposLoading(false));
  }, [shouldLoad, savedLastRepository, savedLastBaseBranch]);
  return { repos, selectedRepo, selectedBaseBranch, setSelectedRepository, reposLoading, loadError };
}

export function useBranchesLoader(selectedRepo: string, selectedBaseBranch: string, setConfig: React.Dispatch<React.SetStateAction<PlannerConfig>>) {
  const [branchesState, setBranchesState] = useState<RepoInfoState>({ isLoading: false, error: null });
  const requestIdRef = useRef(0);
  useEffect(() => {
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    if (!selectedRepo) {
      setBranchesState({ isLoading: false, error: null });
      clearResolvedBaseBranch(setConfig);
      return;
    }
    if (selectedBaseBranch) {
      setBranchesState({ isLoading: false, error: null });
      setResolvedBaseBranch(setConfig, selectedBaseBranch);
      return;
    }
    const [owner, repo] = selectedRepo.split('/');
    if (!owner || !repo) {
      setBranchesState({ isLoading: false, error: 'Invalid repository format' });
      clearResolvedBaseBranch(setConfig);
      return;
    }
    setBranchesState({ isLoading: true, error: null });
    getRepoBranches(owner, repo).then(data => {
      if (requestId !== requestIdRef.current) return;
      setBranchesState({ isLoading: false, error: null });
      setResolvedBaseBranch(setConfig, data.defaultBranch);
    }).catch(err => {
      if (requestId !== requestIdRef.current) return;
      console.error('Failed to load branches:', err);
      setBranchesState({ isLoading: false, error: (err as Error).message });
      clearResolvedBaseBranch(setConfig);
    });
  }, [selectedRepo, selectedBaseBranch, setConfig]);
  return branchesState;
}

export function useRepoInfoLoader(isNewMode: boolean, draft: PlannerDraft | undefined, setConfig: React.Dispatch<React.SetStateAction<PlannerConfig>>) {
  const [repoInfo, setRepoInfo] = useState<RepoInfoState>({ isLoading: !isNewMode, error: null });
  const requestIdRef = useRef(0);
  useEffect(() => {
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    if (isNewMode || !draft) return;
    const draftBaseBranch = (draft as PlannerDraft & { context_config?: { baseBranch?: string } }).context_config?.baseBranch;
    if (draftBaseBranch) {
      setRepoInfo({ isLoading: false, error: null });
      setResolvedBaseBranch(setConfig, draftBaseBranch);
      return;
    }
    const [owner, repo] = draft.repository.split('/');
    if (!owner || !repo) {
      setRepoInfo({ isLoading: false, error: 'Invalid repository format' });
      clearResolvedBaseBranch(setConfig);
      return;
    }

    setRepoInfo({ isLoading: true, error: null });
    getRepoBranches(owner, repo).then(info => {
      if (requestId !== requestIdRef.current) return;
      setRepoInfo({ isLoading: false, error: null });
      setResolvedBaseBranch(setConfig, info.defaultBranch);
    }).catch(err => {
      if (requestId !== requestIdRef.current) return;
      setRepoInfo({ isLoading: false, error: (err as Error).message });
      clearResolvedBaseBranch(setConfig);
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

export function usePlannerSettingsPersistence(config: PlannerConfig, draftRepository: string | undefined, draftBaseBranch: string | undefined, selectedRepo: string, selectedBaseBranch: string) {
  useEffect(() => { savePlannerSettings({ lastGranularity: config.granularity, lastContextLevel: config.contextLevel }); }, [config.granularity, config.contextLevel]);
  useEffect(() => {
    const repo = draftRepository || selectedRepo;
    const baseBranch = draftRepository ? draftBaseBranch : selectedBaseBranch || null;
    if (repo) savePlannerSettings({ lastRepository: repo, lastBaseBranch: baseBranch || null });
  }, [draftBaseBranch, draftRepository, selectedRepo, selectedBaseBranch]);
}

export function useFileHandling(isNewMode: boolean, draft: PlannerDraft | undefined, setConfig: React.Dispatch<React.SetStateAction<PlannerConfig>>, setError: React.Dispatch<React.SetStateAction<string | null>>) {
  const [localFiles, setLocalFiles] = useState<File[]>([]);
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const handleUpload = useCallback(async (file: File) => {
    setIsUploading(true);
    setError(null);
    try {
      const processedFile = await processFileForUpload(file);
      if (isNewMode) setLocalFiles(prev => [...prev, processedFile]);
      else if (draft) {
        const uploadedFile = await uploadAttachment(draft.draft_id, processedFile);
        setConfig(prev => ({ ...prev, files: [...prev.files, uploadedFile] }));
      }
    } catch (err) { setError((err as Error).message || 'Failed to upload file'); }
    finally { setIsUploading(false); }
  }, [isNewMode, draft, setConfig, setError]);
  const handleRemoveFile = useCallback(async (attachmentId: string) => {
    if (!draft) return;
    try {
      await removeAttachment(draft.draft_id, attachmentId);
      setConfig(prev => ({ ...prev, files: prev.files.filter(f => f.id !== attachmentId) }));
    } catch (err) { setError((err as Error).message || 'Failed to remove file'); }
  }, [draft, setConfig, setError]);
  const handleRemoveLocalFile = useCallback((fileIndex: number) => { setLocalFiles(prev => prev.filter((_, i) => i !== fileIndex)); }, []);
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

interface GenerationHandlersParams { draft: PlannerDraft | undefined; config: PlannerConfig; branchError: string | null; contextHelpers: { isContextStale: boolean; clearCountdown: () => void; fetchPreview: () => Promise<void> };
  startPolling: () => void; stopPolling: () => void; setError: React.Dispatch<React.SetStateAction<string | null>>; setGenerationError: (error: string | null) => void; }

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
      await generatePlan(draft.draft_id, buildGenerationPayload(config));
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

interface DraftCreationParams { selectedRepo: string; config: PlannerConfig; localFiles: File[]; onDraftCreated?: (draftId: string) => void;
  navigate: (path: string, options?: { replace?: boolean; state?: unknown }) => void; setError: React.Dispatch<React.SetStateAction<string | null>>; setIsCreating: React.Dispatch<React.SetStateAction<boolean>>; todoIds?: string[]; }

export function useDraftCreation({ selectedRepo, config, localFiles, onDraftCreated, navigate, setError, setIsCreating, todoIds }: DraftCreationParams) {
  const handleCreateDraftAndGenerate = useCallback(async () => {
    if (!selectedRepo || !config.prompt.trim()) {
      setError('Please select a repository and enter a prompt');
      return;
    }
    if (!config.baseBranch) {
      setError('Please wait for the repository branch to finish loading');
      return;
    }
    setIsCreating(true);
    setError(null);
    try {
      const { createDraft } = await import('../../api/proprApi');
      const newDraft = await createDraft(selectedRepo, config.prompt.trim(), { todoIds });
      let baseBranchPersistenceWarning: string | null = null;
      try {
        await persistResolvedBaseBranch(newDraft.draft_id, config.baseBranch);
      } catch (err) {
        console.error('Failed to persist resolved base branch:', err);
        baseBranchPersistenceWarning = getBaseBranchPersistenceWarning(config.baseBranch);
      }
      for (const file of localFiles) {
        try { await uploadAttachment(newDraft.draft_id, file); }
        catch (uploadErr) { console.error('Failed to upload attachment:', uploadErr); }
      }
      if (onDraftCreated) onDraftCreated(newDraft.draft_id);
      await generatePlan(newDraft.draft_id, buildGenerationPayload(config));
      const draftWithPlan = constructDraftWithPlan(newDraft, config.baseBranch);
      draftWithPlan.status = 'generating';
      navigate(`/studio/${newDraft.draft_id}`, {
        replace: true,
        state: {
          initialDraft: draftWithPlan,
          initialBaseBranch: config.baseBranch,
          baseBranchPersistenceWarning
        }
      });
    } catch (err) {
      setError((err as Error).message || 'Failed to create draft');
      setIsCreating(false);
    }
  }, [selectedRepo, config, localFiles, onDraftCreated, navigate, setError, setIsCreating, todoIds]);

  return handleCreateDraftAndGenerate;
}

interface GenerateDisabledParams { isNewMode: boolean; isCreating: boolean; selectedRepo: string; promptTrimmed: string; reposLoading: boolean;
  isGenerating: boolean; branchError: string | null; repoInfoLoading: boolean; repoError: string | null; baseBranch: string; }

export function computeIsGenerateDisabled(p: GenerateDisabledParams): boolean {
  if (p.isNewMode) {
    return p.isCreating || !p.selectedRepo || !p.promptTrimmed || p.reposLoading || p.repoInfoLoading || !!p.repoError || !p.baseBranch;
  }
  return p.isCreating || p.isGenerating || !!p.branchError || p.repoInfoLoading || !!p.repoError || !p.promptTrimmed || !p.baseBranch;
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

type DraftWithContextConfig = PlannerDraft & { context_config?: DraftContextConfig };

export function useDraftContextConfigSync(draft: PlannerDraft | undefined, setConfig: React.Dispatch<React.SetStateAction<PlannerConfig>>) {
  useEffect(() => {
    if (!draft) return;
    const draftConfig = (draft as DraftWithContextConfig).context_config;
    setConfig(prev => (
      prev.prompt === draft.initial_prompt &&
      prev.baseBranch === (draftConfig?.baseBranch ?? '') &&
      JSON.stringify(prev.files) === JSON.stringify(draft.attachments ?? []) &&
      JSON.stringify(prev.contextRepositories) === JSON.stringify(draftConfig?.contextRepositories ?? []) &&
      prev.generationModel === (draftConfig?.generationModel ?? null) &&
      JSON.stringify(prev.manualFiles) === JSON.stringify(draftConfig?.manualFiles ?? []) &&
      JSON.stringify(prev.excludedFiles) === JSON.stringify(draftConfig?.excludedFiles ?? [])
    ) ? prev : {
      ...prev,
      prompt: draft.initial_prompt,
      baseBranch: draftConfig?.baseBranch ?? '',
      files: draft.attachments ?? [],
      contextRepositories: draftConfig?.contextRepositories ?? [],
      generationModel: draftConfig?.generationModel ?? null,
      manualFiles: draftConfig?.manualFiles ?? [],
      excludedFiles: draftConfig?.excludedFiles ?? []
    });
  }, [draft?.draft_id, setConfig]);
}

export function usePreviewTrace(draft: PlannerDraft | undefined, draftId: string, isPreviewLoading: boolean) {
  const [previewTrace, setPreviewTrace] = useState<GenerationTrace | undefined>();
  useEffect(() => {
    if (!draftId || !isPreviewLoading) return void (!isPreviewLoading && setPreviewTrace(undefined));
    if (draft?.generation_trace?.steps?.length) return void setPreviewTrace(draft.generation_trace);
    setPreviewTrace({ steps: [{ name: 'relevance', status: 'in_progress' }, { name: 'context', status: 'pending' }] });
  }, [draftId, draft?.generation_trace, isPreviewLoading]);
  return previewTrace;
}

export function useSetupWizardEffects({ autoResize, prompt, generationError, repoLoadError, autoCreateError, autoCreateWarning, baseBranchPersistenceWarning, addToast, setError }: { autoResize: () => void; prompt: string; generationError: string | null; repoLoadError: string | null; autoCreateError?: string | null; autoCreateWarning?: string | null; baseBranchPersistenceWarning?: string | null; addToast: ({ type, message }: { type: 'error' | 'warning'; message: string }) => void; setError: React.Dispatch<React.SetStateAction<string | null>>; }) {
  useEffect(() => { autoResize(); }, [prompt, autoResize]);
  useEffect(() => { if (generationError) addToast({ type: 'error', message: `Plan generation failed: ${generationError}` }); }, [generationError, addToast]);
  useEffect(() => { if (repoLoadError) setError(repoLoadError); }, [repoLoadError, setError]);
  useEffect(() => { if (autoCreateError) addToast({ type: 'error', message: autoCreateError }); }, [autoCreateError, addToast]);
  useEffect(() => { if (autoCreateWarning) addToast({ type: 'warning', message: autoCreateWarning }); }, [autoCreateWarning, addToast]);
  useEffect(() => { if (baseBranchPersistenceWarning) addToast({ type: 'warning', message: baseBranchPersistenceWarning }); }, [baseBranchPersistenceWarning, addToast]);
}

function truncateToSentences(text: string): string {
  const trimmed = text.trim();
  const sentencePattern = /[^.!?]+[.!?]+/g;
  const sentences: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = sentencePattern.exec(trimmed)) !== null && sentences.length < 2) sentences.push(match[0].trim());
  if (sentences.length > 0) return sentences.join(' ');
  if (trimmed.length <= 100) return trimmed;
  const truncated = trimmed.slice(0, 100);
  const lastSpace = truncated.lastIndexOf(' ');
  return lastSpace > 0 ? truncated.slice(0, lastSpace) + '...' : truncated + '...';
}

const PROMPT_SAVE_DEBOUNCE = 1000;

export function usePromptPersistence(draftId: string | undefined, prompt: string, initialPrompt: string | undefined) {
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedPromptRef = useRef<string>((initialPrompt || '').trim());
  const isMountedRef = useRef(true);
  const previousDraftIdRef = useRef<string | undefined>(draftId);
  useEffect(() => { isMountedRef.current = true; return () => { isMountedRef.current = false; if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current); }; }, []);
  useEffect(() => {
    lastSavedPromptRef.current = (initialPrompt || '').trim();
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
  }, [draftId, initialPrompt]);
  useEffect(() => {
    if (!draftId) return;
    const draftChanged = previousDraftIdRef.current !== draftId;
    previousDraftIdRef.current = draftId;
    if (draftChanged) return;
    const trimmedPrompt = prompt.trim();
    if (trimmedPrompt === lastSavedPromptRef.current) return;
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(async () => {
      if (!isMountedRef.current) return;
      try {
        const name = truncateToSentences(trimmedPrompt);
        await updateDraft(draftId, { initial_prompt: trimmedPrompt, name });
        lastSavedPromptRef.current = trimmedPrompt;
      } catch (err) { console.error('Failed to persist prompt:', err); }
    }, PROMPT_SAVE_DEBOUNCE);
    return () => { if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current); };
  }, [draftId, prompt]);
}
