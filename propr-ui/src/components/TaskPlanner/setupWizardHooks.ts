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
export interface PlannerConfig { prompt: string; baseBranch: string; granularity: Granularity; contextLevel: number; compress: boolean; files: PlannerAttachment[]; contextRepositories: { repository: string; branch?: string }[]; generationModel: string | null; manualFiles: string[]; excludedFiles: string[]; }
interface RepoInfoState { isLoading: boolean; error: string | null; }
interface GenerationHandlersParams { draft: PlannerDraft | undefined; config: PlannerConfig; branchError: string | null; contextHelpers: { isContextStale: boolean; clearCountdown: () => void; fetchPreview: () => Promise<void> }; startPolling: () => void; stopPolling: () => void; setError: React.Dispatch<React.SetStateAction<string | null>>; setGenerationError: (error: string | null) => void; }
interface DraftCreationParams { selectedRepo: string; config: PlannerConfig; localFiles: File[]; onDraftCreated?: (draftId: string) => void; navigate: (path: string, options?: { replace?: boolean; state?: unknown }) => void; setError: React.Dispatch<React.SetStateAction<string | null>>; setIsCreating: React.Dispatch<React.SetStateAction<boolean>>; todoIds?: string[]; }
interface GenerateDisabledParams { isNewMode: boolean; isCreating: boolean; selectedRepo: string; promptTrimmed: string; reposLoading: boolean; isGenerating: boolean; branchError: string | null; repoInfoLoading: boolean; repoError: string | null; baseBranch: string; }
type PlannerConfigSetter = React.Dispatch<React.SetStateAction<PlannerConfig>>;
type DraftWithContextConfig = PlannerDraft & { context_config?: DraftContextConfig };
type DraftConfigSnapshot = Pick<PlannerConfig, 'prompt' | 'baseBranch' | 'granularity' | 'contextLevel' | 'compress' | 'files' | 'contextRepositories' | 'generationModel' | 'manualFiles' | 'excludedFiles'>;
type PersistedDraftSettings = Pick<PlannerConfig, 'baseBranch' | 'granularity' | 'contextLevel' | 'compress' | 'contextRepositories' | 'generationModel' | 'manualFiles' | 'excludedFiles'>;
type PersistDraftUpdate = Parameters<typeof updateDraft>[1];
const PROMPT_SAVE_DEBOUNCE = 1000;
const SETTINGS_SAVE_DEBOUNCE = 1000;
const ensureArray = <T,>(value: T[] | unknown): T[] => Array.isArray(value) ? value : [];
const clearResolvedBaseBranch = (setConfig: PlannerConfigSetter) => setConfig(prev => prev.baseBranch ? { ...prev, baseBranch: '' } : prev);
const setResolvedBaseBranch = (setConfig: PlannerConfigSetter, baseBranch: string) => setConfig(prev => prev.baseBranch === baseBranch ? prev : { ...prev, baseBranch });
async function loadRepositories(savedLastRepository: string | undefined, savedLastBaseBranch: string | undefined): Promise<{ repos: Repo[]; selectedRepo: string; selectedBaseBranch: string }> {
  const [repoData, userPrefs, indexingData] = await Promise.all([getRepoConfig() as Promise<{ repos_to_monitor?: unknown[] }>, getUserRepoPreferences().catch(() => ({} as UserRepoPreferences)), getRepositoriesIndexingStatus().catch(() => ({ repositories: [] as RepositoryIndexingStatus[] }))]);
  const indexingMap = new Map<string, RepositoryIndexingStatus>();
  for (const status of indexingData.repositories || []) indexingMap.set(status.full_name, status);
  const enabledRepos = (repoData.repos_to_monitor || []).filter((repo): repo is { name: string; enabled?: boolean; baseBranch?: string } => typeof repo === 'object' && repo !== null && 'name' in repo && typeof (repo as { name: unknown }).name === 'string').map(repo => {
    const prefs = userPrefs[repo.name];
    const indexingStatus = indexingMap.get(repo.name);
    return { name: repo.name, enabled: repo.enabled !== false, baseBranch: repo.baseBranch, starred: prefs?.starred || false, iconPath: indexingStatus?.icon_path || null };
  }).filter(repo => repo.enabled);
  const selectedRepoEntry = savedLastRepository ? enabledRepos.find(repo => repo.name === savedLastRepository && (repo.baseBranch || '') === (savedLastBaseBranch || '')) || enabledRepos.find(repo => repo.name === savedLastRepository) : enabledRepos[0];
  return { repos: enabledRepos, selectedRepo: selectedRepoEntry?.name || '', selectedBaseBranch: selectedRepoEntry?.baseBranch || '' };
}
async function loadIndexedRepositories(repoToExclude: string): Promise<IndexedRepository[]> {
  const data = await getRepositoriesIndexingStatus();
  return (data.repositories || []).filter(repo => (repo.indexing_status === 'completed' || repo.indexing_status === 'indexing') && repo.full_name !== repoToExclude).map(repo => ({ full_name: repo.full_name, branch: repo.branch, indexing_status: repo.indexing_status }));
}
function buildGenerationPayload(config: PlannerConfig) { return { baseBranch: config.baseBranch, granularity: config.granularity, contextLevel: config.contextLevel, compress: config.compress, contextRepositories: config.contextRepositories, generationModel: config.generationModel || undefined, excludedFiles: config.excludedFiles.length > 0 ? config.excludedFiles : undefined }; }
function getDraftConfigSnapshot(draft: PlannerDraft | undefined): DraftConfigSnapshot | null {
  if (!draft) return null;
  const draftConfig = (draft as DraftWithContextConfig).context_config;
  return { prompt: draft.initial_prompt, baseBranch: draftConfig?.baseBranch ?? '', granularity: draftConfig?.granularity ?? 'balanced', contextLevel: draftConfig?.contextLevel ?? 50, compress: draftConfig?.compress ?? false, files: ensureArray<PlannerAttachment>(draft.attachments), contextRepositories: ensureArray<{ repository: string; branch?: string }>(draftConfig?.contextRepositories), generationModel: draftConfig?.generationModel ?? null, manualFiles: ensureArray<string>(draftConfig?.manualFiles), excludedFiles: ensureArray<string>(draftConfig?.excludedFiles) };
}
function matchesDraftConfig(prev: PlannerConfig, next: DraftConfigSnapshot): boolean {
  return prev.prompt === next.prompt && prev.baseBranch === next.baseBranch && prev.granularity === next.granularity && prev.contextLevel === next.contextLevel && prev.compress === next.compress && JSON.stringify(prev.files) === JSON.stringify(next.files) && JSON.stringify(prev.contextRepositories) === JSON.stringify(next.contextRepositories) && prev.generationModel === next.generationModel && JSON.stringify(prev.manualFiles) === JSON.stringify(next.manualFiles) && JSON.stringify(prev.excludedFiles) === JSON.stringify(next.excludedFiles);
}
function getPersistedDraftSettings(config: PlannerConfig): PersistedDraftSettings { return { baseBranch: config.baseBranch, granularity: config.granularity, contextLevel: config.contextLevel, compress: config.compress, contextRepositories: config.contextRepositories, generationModel: config.generationModel, manualFiles: config.manualFiles, excludedFiles: config.excludedFiles }; }
function serializePersistedDraftSettings(settings: PersistedDraftSettings): string { return JSON.stringify(settings); }
function useResolvedBaseBranch({ repository, configuredBaseBranch, shouldResolve, initialLoading, setConfig }: { repository: string; configuredBaseBranch?: string; shouldResolve: boolean; initialLoading: boolean; setConfig: PlannerConfigSetter; }) {
  const [state, setState] = useState<RepoInfoState>({ isLoading: initialLoading, error: null });
  const requestIdRef = useRef(0);
  useEffect(() => {
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    if (!shouldResolve) return;
    if (!repository) return void (setState({ isLoading: false, error: null }), clearResolvedBaseBranch(setConfig));
    if (configuredBaseBranch) return void (setState({ isLoading: false, error: null }), setResolvedBaseBranch(setConfig, configuredBaseBranch));
    const [owner, repo] = repository.split('/');
    if (!owner || !repo) return void (setState({ isLoading: false, error: 'Invalid repository format' }), clearResolvedBaseBranch(setConfig));
    setState({ isLoading: true, error: null });
    getRepoBranches(owner, repo).then(data => {
      if (requestId !== requestIdRef.current) return;
      setState({ isLoading: false, error: null });
      setResolvedBaseBranch(setConfig, data.defaultBranch);
    }).catch(err => {
      if (requestId !== requestIdRef.current) return;
      console.error('Failed to load branches:', err);
      setState({ isLoading: false, error: (err as Error).message });
      clearResolvedBaseBranch(setConfig);
    });
  }, [repository, configuredBaseBranch, shouldResolve, setConfig]);
  return state;
}
function useDebouncedDraftPersistence(savedValue: string, draftId: string | undefined) {
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);
  const lastSavedValueRef = useRef(savedValue);
  const previousDraftIdRef = useRef<string | undefined>(draftId);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    lastSavedValueRef.current = savedValue;
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
  }, [draftId, savedValue]);
  return { debounceTimerRef, isMountedRef, lastSavedValueRef, previousDraftIdRef };
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
  return lastSpace > 0 ? `${truncated.slice(0, lastSpace)}...` : `${truncated}...`;
}
async function processFileForUpload(file: File): Promise<File> { return file.type.startsWith('image/') ? resizeImage(file) : file; }
export function useRepositoryLoader(shouldLoad: boolean, savedLastRepository: string | undefined, savedLastBaseBranch: string | undefined) {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedRepo, setSelectedRepo] = useState('');
  const [selectedBaseBranch, setSelectedBaseBranch] = useState('');
  const [reposLoading, setReposLoading] = useState(shouldLoad);
  const [loadError, setLoadError] = useState<string | null>(null);
  const setSelectedRepository = useCallback((repo: string, selection?: string | RepoSelection) => { setSelectedRepo(repo); setSelectedBaseBranch(typeof selection === 'string' ? selection : selection?.baseBranch || ''); }, []);
  useEffect(() => {
    if (!shouldLoad) return;
    setReposLoading(true);
    loadRepositories(savedLastRepository, savedLastBaseBranch).then(({ repos: loadedRepos, selectedRepo: defaultRepo, selectedBaseBranch: defaultBaseBranch }) => {
      setRepos(loadedRepos);
      setSelectedRepo(defaultRepo);
      setSelectedBaseBranch(defaultBaseBranch);
    }).catch(err => {
      console.error('Failed to load repositories:', err);
      setLoadError('Failed to load repositories');
    }).finally(() => setReposLoading(false));
  }, [shouldLoad, savedLastRepository, savedLastBaseBranch]);
  return { repos, selectedRepo, selectedBaseBranch, setSelectedRepository, reposLoading, loadError };
}
export function useBranchesLoader(selectedRepo: string, selectedBaseBranch: string, setConfig: PlannerConfigSetter) { return useResolvedBaseBranch({ repository: selectedRepo, configuredBaseBranch: selectedBaseBranch, shouldResolve: true, initialLoading: false, setConfig }); }
export function useRepoInfoLoader(isNewMode: boolean, draft: PlannerDraft | undefined, setConfig: PlannerConfigSetter) {
  return useResolvedBaseBranch({ repository: draft?.repository || '', configuredBaseBranch: (draft as DraftWithContextConfig | undefined)?.context_config?.baseBranch, shouldResolve: !isNewMode && !!draft, initialLoading: !isNewMode, setConfig });
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
export function useFileHandling(isNewMode: boolean, draft: PlannerDraft | undefined, setConfig: PlannerConfigSetter, setError: React.Dispatch<React.SetStateAction<string | null>>) {
  const [localFiles, setLocalFiles] = useState<File[]>([]);
  const [isUploading, setIsUploading] = useState(false);
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
      setConfig(prev => ({ ...prev, files: prev.files.filter(file => file.id !== attachmentId) }));
    } catch (err) {
      setError((err as Error).message || 'Failed to remove file');
    }
  }, [draft, setConfig, setError]);
  const handleRemoveLocalFile = useCallback((fileIndex: number) => setLocalFiles(prev => prev.filter((_, index) => index !== fileIndex)), []);
  const handlePaste = useCallback(async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const imageItem = Array.from(event.clipboardData?.items || []).find(item => item.type.startsWith('image/'));
    if (!imageItem) return;
    event.preventDefault();
    const blob = imageItem.getAsFile();
    if (!blob) return;
    try {
      await handleUpload(await resizeImage(new File([blob], `pasted-image-${Date.now()}.png`, { type: blob.type })));
    } catch (err) {
      setError('Failed to process pasted image');
      console.error('Paste error:', err);
    }
  }, [handleUpload, setError]);
  return { localFiles, isUploading, handleUpload, handleRemoveFile, handleRemoveLocalFile, handlePaste };
}
export function useGenerationHandlers({ draft, config, branchError, contextHelpers, startPolling, stopPolling, setError, setGenerationError }: GenerationHandlersParams) {
  const handleGenerateForExistingDraft = useCallback(async () => {
    if (!draft) return;
    if (branchError) return void setError('Please fix the branch name before generating');
    setError(null);
    setGenerationError(null);
    startPolling();
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
export function useDraftCreation({ selectedRepo, config, localFiles, onDraftCreated, navigate, setError, setIsCreating, todoIds }: DraftCreationParams) {
  return useCallback(async () => {
    if (!selectedRepo || !config.prompt.trim()) return void setError('Please select a repository and enter a prompt');
    if (!config.baseBranch) return void setError('Please wait for the repository branch to finish loading');
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
        try { await uploadAttachment(newDraft.draft_id, file); } catch (uploadErr) { console.error('Failed to upload attachment:', uploadErr); }
      }
      if (onDraftCreated) onDraftCreated(newDraft.draft_id);
      await generatePlan(newDraft.draft_id, buildGenerationPayload(config));
      const draftWithPlan = constructDraftWithPlan(newDraft, config.baseBranch);
      draftWithPlan.status = 'generating';
      navigate(`/studio/${newDraft.draft_id}`, { replace: true, state: { initialDraft: draftWithPlan, initialBaseBranch: config.baseBranch, baseBranchPersistenceWarning } });
    } catch (err) {
      setError((err as Error).message || 'Failed to create draft');
      setIsCreating(false);
    }
  }, [selectedRepo, config, localFiles, onDraftCreated, navigate, setError, setIsCreating, todoIds]);
}
export function computeIsGenerateDisabled(params: GenerateDisabledParams): boolean {
  if (params.isNewMode) return params.isCreating || !params.selectedRepo || !params.promptTrimmed || params.reposLoading || params.repoInfoLoading || !!params.repoError || !params.baseBranch;
  return params.isCreating || params.isGenerating || !!params.branchError || params.repoInfoLoading || !!params.repoError || !params.promptTrimmed || !params.baseBranch;
}
export function computeCanExport(isNewMode: boolean, promptTrimmed: string, baseBranch: string): boolean { return !isNewMode && !!(promptTrimmed && baseBranch); }
export function useAutoResize(textareaRef: React.RefObject<HTMLTextAreaElement | null>) {
  return useCallback(() => {
    const element = textareaRef.current;
    if (element) { element.style.height = 'auto'; element.style.height = `${Math.max(element.scrollHeight, 160)}px`; }
  }, [textareaRef]);
}
export function useDraftContextConfigSync(draft: PlannerDraft | undefined, setConfig: PlannerConfigSetter) {
  const draftSnapshot = getDraftConfigSnapshot(draft);
  const previousDraftIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!draftSnapshot) return;
    const draftChanged = previousDraftIdRef.current !== draft?.draft_id;
    previousDraftIdRef.current = draft?.draft_id;
    if (!draftChanged) return;
    setConfig(prev => matchesDraftConfig(prev, draftSnapshot) ? prev : { ...prev, ...draftSnapshot });
  }, [draft?.draft_id, draftSnapshot, setConfig]);
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
export function usePromptPersistence(draftId: string | undefined, prompt: string, initialPrompt: string | undefined) {
  const trimmedPrompt = prompt.trim();
  const { debounceTimerRef, isMountedRef, lastSavedValueRef, previousDraftIdRef } = useDebouncedDraftPersistence((initialPrompt || '').trim(), draftId);
  useEffect(() => {
    if (!draftId) return;
    const draftChanged = previousDraftIdRef.current !== draftId;
    previousDraftIdRef.current = draftId;
    if (draftChanged || trimmedPrompt === lastSavedValueRef.current) return;
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(async () => {
      if (!isMountedRef.current) return;
      try {
        await updateDraft(draftId, { initial_prompt: trimmedPrompt, name: truncateToSentences(trimmedPrompt) });
        lastSavedValueRef.current = trimmedPrompt;
      } catch (err) {
        console.error('Failed to persist prompt:', err);
      }
    }, PROMPT_SAVE_DEBOUNCE);
    return () => { if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current); };
  }, [draftId, trimmedPrompt, debounceTimerRef, isMountedRef, lastSavedValueRef, previousDraftIdRef]);
}
export function useDraftSettingsPersistence(draftId: string | undefined, config: PlannerConfig, draft: PlannerDraft | undefined) {
  const serverSettings = draft ? getPersistedDraftSettings({ ...config, ...(getDraftConfigSnapshot(draft) ?? {}) }) : null;
  const settings = getPersistedDraftSettings(config);
  const serializedSettings = serializePersistedDraftSettings(settings);
  const { debounceTimerRef, isMountedRef, lastSavedValueRef, previousDraftIdRef } = useDebouncedDraftPersistence(serverSettings ? serializePersistedDraftSettings(serverSettings) : '', draftId);
  useEffect(() => {
    if (!draftId) return;
    const draftChanged = previousDraftIdRef.current !== draftId;
    previousDraftIdRef.current = draftId;
    if (draftChanged || serializedSettings === lastSavedValueRef.current) return;
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(async () => {
      if (!isMountedRef.current) return;
      try {
        await updateDraft(draftId, { context_config: settings } as PersistDraftUpdate & { context_config: PersistedDraftSettings });
        lastSavedValueRef.current = serializedSettings;
      } catch (err) {
        console.error('Failed to persist draft settings:', err);
      }
    }, SETTINGS_SAVE_DEBOUNCE);
    return () => { if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current); };
  }, [draftId, settings, serializedSettings, debounceTimerRef, isMountedRef, lastSavedValueRef, previousDraftIdRef]);
}
