import React, { useState, useRef, useCallback, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Download, Loader2 } from 'lucide-react';
import { DraftContextConfig, PlannerDraft, createDraft, GenerationTrace, getRepoBranches } from '../../api/proprApi';
import { getPlannerSettings } from '../../hooks/usePlannerSettings';
import { useGenerationPolling } from '../../hooks/useGenerationPolling';
import { useContextExport } from '../../hooks/useContextExport';
import { useContextRefresh } from '../../hooks/useContextRefresh';
import { useToast } from '../ui/useToast';
import { SetupWizardLeftPane } from './SetupWizardLeftPane';
import { SetupWizardRightPane } from './SetupWizardRightPane';
import { GranularityPills } from './ComposerControls';
import { GenerateButtonContent, ModelSelector } from './SetupWizardComponents';
import { getEstimatedIssueText } from './setupWizardUtils';
import type { RepoSelection } from '../RepositorySelector';
import {
  PlannerConfig,
  useRepositoryLoader,
  useBranchesLoader,
  useRepoInfoLoader,
  useAgentsLoader,
  useIndexedRepositoriesLoader,
  usePlannerSettingsPersistence,
  useFileHandling,
  useGenerationHandlers,
  useDraftCreation,
  useAutoDraftCreation,
  constructDraftWithPlan,
  persistDraftSetupSnapshot,
  getDraftSetupPersistenceWarning,
  usePromptPersistence,
  useDraftSettingsPersistence,
  computeIsGenerateDisabled,
  computeCanExport,
  useAutoResize,
  useDraftContextConfigSync,
  usePreviewTrace,
  useSetupWizardEffects
} from './setupWizardHooks';
import { getDraftSetupSnapshot } from './setupWizardPayloads';

interface SetupWizardProps {
  draft?: PlannerDraft;
  onGenerateComplete: () => void;
  onDraftCreated?: (draftId: string) => void;
  onDraftCreatedInPlace?: (draft: PlannerDraft) => void;
}

type SetupWizardContentProps = { isNewMode: boolean; draft: PlannerDraft | undefined; config: PlannerConfig; setConfig: React.Dispatch<React.SetStateAction<PlannerConfig>>; repoLoader: ReturnType<typeof useRepositoryLoader>; newModeBranches: ReturnType<typeof useBranchesLoader>; repoInfo: ReturnType<typeof useRepoInfoLoader>; fileHandling: ReturnType<typeof useFileHandling>; generationPolling: ReturnType<typeof useGenerationPolling>; contextExport: ReturnType<typeof useContextExport>; contextRefresh: ReturnType<typeof useContextRefresh>; generationHandlers: ReturnType<typeof useGenerationHandlers>; autoResize: () => void; textareaRef: React.RefObject<HTMLTextAreaElement | null>; fileInputRef: React.RefObject<HTMLInputElement | null>; error: string | null; branchError: string | null; isCreating: boolean; initialConfiguredBaseBranch: string; handleRepoChangeInEditMode: (repo: string, selection?: RepoSelection) => Promise<void>; handleFileInputChange: (e: React.ChangeEvent<HTMLInputElement>) => Promise<void>; handleExportContext: () => void; handleGenerate: () => Promise<void>; agents: ReturnType<typeof useAgentsLoader>; availableRepos: ReturnType<typeof useIndexedRepositoriesLoader>; previewTrace?: GenerationTrace };

const SetupWizardContent: React.FC<SetupWizardContentProps> = (props) => {
  const { isNewMode, draft, config, setConfig, repoLoader, newModeBranches, repoInfo, fileHandling, generationPolling, contextExport, contextRefresh, generationHandlers, autoResize, textareaRef, fileInputRef, error, branchError, isCreating, initialConfiguredBaseBranch, handleRepoChangeInEditMode, handleFileInputChange, handleExportContext, handleGenerate, agents, availableRepos, previewTrace } = props;
  const repository = draft?.repository ?? repoLoader.selectedRepo;
  const isRepoLoading = isNewMode ? newModeBranches.isLoading : repoInfo.isLoading;
  const repoError = isNewMode ? newModeBranches.error : repoInfo.error;
  const onRepoChange = isNewMode ? repoLoader.setSelectedRepository : handleRepoChangeInEditMode;
  const promptTrimmed = config.prompt.trim();
  const setPrompt = updateConfigField(setConfig, 'prompt');
  const setContextLevel = updateConfigField(setConfig, 'contextLevel');
  const setGranularity = updateConfigField(setConfig, 'granularity');
  const isGenerateDisabled = computeIsGenerateDisabled({
    isNewMode, isCreating, selectedRepo: repoLoader.selectedRepo, promptTrimmed,
    reposLoading: repoLoader.reposLoading, isGenerating: generationPolling.isGenerating,
    branchError, repoInfoLoading: isRepoLoading, repoError, baseBranch: config.baseBranch
  });
  const canExport = computeCanExport(isNewMode, promptTrimmed, config.baseBranch);
  const handleModelChange = updateConfigField(setConfig, 'generationModel');
  const handleAddContextRepo = appendConfigArrayValue(setConfig, 'contextRepositories');
  const handleRemoveContextRepo = removeConfigArrayValue(setConfig, 'contextRepositories', (value, repository) => value.repository === repository);
  const handleAddManualFile = appendConfigArrayValue(setConfig, 'manualFiles');
  const handleRemoveManualFile = removeConfigArrayValue(setConfig, 'manualFiles', (value, filePath) => value === filePath);
  const handleExcludeFile = appendConfigArrayValue(setConfig, 'excludedFiles');
  const isGenerating = generationPolling.isGenerating;
  const stats = contextRefresh.preview.data?.stats;
  const configuredBaseBranch = (draft as DraftWithContextConfig | undefined)?.context_config?.baseBranch;
  return (
    <div className="h-full flex flex-col bg-white">
      <div className="flex-1 flex flex-col md:flex-row min-h-0 overflow-auto">
        <SetupWizardLeftPane
          isNewMode={isNewMode}
          repository={repository}
          repos={repoLoader.repos}
          selectedRepo={repoLoader.selectedRepo}
          selectedBaseBranch={isNewMode ? repoLoader.selectedBaseBranch : initialConfiguredBaseBranch}
          configuredBaseBranch={configuredBaseBranch}
          onRepoChange={onRepoChange}
          reposLoading={repoLoader.reposLoading}
          baseBranch={config.baseBranch}
          isRepoLoading={isRepoLoading}
          branchError={branchError}
          repoError={repoError}
          prompt={config.prompt}
          onPromptChange={setPrompt}
          textareaRef={textareaRef}
          autoResize={autoResize}
          onPaste={fileHandling.handlePaste}
          files={config.files}
          localFiles={fileHandling.localFiles}
          draftId={draft?.draft_id}
          onRemoveFile={fileHandling.handleRemoveFile}
          onRemoveLocalFile={fileHandling.handleRemoveLocalFile}
          isUploading={fileHandling.isUploading}
          fileInputRef={fileInputRef}
          onFileInputChange={handleFileInputChange}
          error={error}
          generationError={generationPolling.generationError}
          isGenerating={isGenerating}
          generationTrace={generationPolling.generationTrace}
          onAbort={generationHandlers.handleAbortGeneration}
          manualFiles={config.manualFiles}
          onAddManualFile={handleAddManualFile}
          onRemoveManualFile={handleRemoveManualFile}
        />
        <SetupWizardRightPane
          contextLevel={config.contextLevel}
          onContextLevelChange={setContextLevel}
          smartSelection={contextRefresh.preview.data?.smartSelection}
          isPreviewLoading={contextRefresh.preview.isLoading}
          stats={stats}
          contextRepositories={config.contextRepositories}
          availableRepos={availableRepos}
          onAddContextRepo={handleAddContextRepo}
          onRemoveContextRepo={handleRemoveContextRepo}
          preview={contextRefresh.preview}
          isContextStale={contextRefresh.isContextStale}
          timeUntilRefresh={contextRefresh.timeUntilRefresh}
          isPaused={contextRefresh.isPaused}
          onTogglePause={contextRefresh.togglePause}
          onManualRefresh={contextRefresh.handleManualRefresh}
          isNewMode={isNewMode}
          previewTrace={previewTrace}
          showPreviewProgress={!isGenerating}
          onExcludeFile={handleExcludeFile}
        />
      </div>
      <div className="flex-shrink-0 px-3 md:px-6 py-2 md:py-4 bg-gray-100 border-t border-gray-300">
        <div className="flex flex-col gap-2 md:gap-4">
          <div className="flex items-center gap-2 overflow-x-auto">
            <span className="text-xs sm:text-sm text-gray-500 whitespace-nowrap">Break plan:</span>
            <GranularityPills
              value={config.granularity}
              onChange={setGranularity}
              hideEstimate
            />
          </div>
          <div className="flex items-center gap-2 sm:gap-3 md:gap-4">
            <button
              onClick={handleGenerate}
              disabled={isGenerateDisabled}
              className="flex items-center justify-center gap-1.5 sm:gap-2 px-3 sm:px-4 md:px-6 py-2 md:py-2.5 text-white text-sm sm:text-base font-medium rounded-lg disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors flex-shrink-0"
              style={{ backgroundColor: isGenerateDisabled ? undefined : 'rgb(29, 138, 138)' }}
              onMouseEnter={(e) => { if (!isGenerateDisabled) e.currentTarget.style.backgroundColor = 'rgb(24, 118, 118)'; }}
              onMouseLeave={(e) => { if (!isGenerateDisabled) e.currentTarget.style.backgroundColor = 'rgb(29, 138, 138)'; }}
            >
              <GenerateButtonContent isNewMode={isNewMode} isCreating={isCreating} isGenerating={isGenerating} issueCountText={getEstimatedIssueText(config.granularity)} />
            </button>
            <ModelSelector
              agents={agents}
              generationModel={config.generationModel}
              onModelChange={handleModelChange}
              modelName={stats?.modelName}
            />
            <button
              onClick={handleExportContext}
              disabled={contextExport.isExporting || contextRefresh.preview.isLoading || !canExport}
              className="hidden md:flex items-center gap-1.5 px-3 py-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-md disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm ml-auto"
              title="Export context as XML"
            >
              {contextExport.isExporting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Download className="w-4 h-4" />
              )}
              <span>Export Context</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

interface LocationState { initialPrompt?: string; initialRepository?: string; initialBaseBranch?: string; baseBranchPersistenceWarning?: string | null; todoIds?: string[]; }
type DraftWithContextConfig = PlannerDraft & { context_config?: DraftContextConfig };
const ensureArray = <T,>(value: T[] | unknown): T[] => Array.isArray(value) ? value : [];
const updateConfigField = <K extends keyof PlannerConfig>(setConfig: React.Dispatch<React.SetStateAction<PlannerConfig>>, key: K) => (value: PlannerConfig[K]) => setConfig(prev => ({ ...prev, [key]: value }));
const appendConfigArrayValue = <K extends 'contextRepositories' | 'manualFiles' | 'excludedFiles'>(setConfig: React.Dispatch<React.SetStateAction<PlannerConfig>>, key: K) => (value: PlannerConfig[K][number]) => setConfig(prev => ({ ...prev, [key]: [...prev[key], value] }));
const removeConfigArrayValue = <K extends 'contextRepositories' | 'manualFiles' | 'excludedFiles'>(setConfig: React.Dispatch<React.SetStateAction<PlannerConfig>>, key: K, predicate: (value: PlannerConfig[K][number], target: PlannerConfig[K][number]) => boolean) => (target: PlannerConfig[K][number]) => setConfig(prev => ({ ...prev, [key]: prev[key].filter(value => !predicate(value, target)) }));
interface RepoChangeHandlerParams { draft: PlannerDraft | undefined; config: PlannerConfig; locationTodoIds?: string[]; navigate: ReturnType<typeof useNavigate>; onDraftCreated?: (draftId: string) => void; setError: React.Dispatch<React.SetStateAction<string | null>>; setIsCreating: React.Dispatch<React.SetStateAction<boolean>>; }

function isLatestRepoChange(requestId: number, requestIdRef: React.MutableRefObject<number>) {
  return requestId === requestIdRef.current;
}

function shouldSkipRepoDraftCreation(newRepo: string, resolvedBaseBranch: string, draft: PlannerDraft | undefined, config: PlannerConfig) {
  return newRepo === draft?.repository && resolvedBaseBranch === config.baseBranch;
}

async function resolveRepoBaseBranch(newRepo: string, selection?: RepoSelection) {
  if (selection?.baseBranch) return selection.baseBranch;
  const [owner, repo] = newRepo.split('/');
  if (!owner || !repo) throw new Error('Invalid repository format');
  const repoInfo = await getRepoBranches(owner, repo);
  return repoInfo.defaultBranch;
}

async function persistDraftSetupWarning(draftId: string, config: PlannerConfig, resolvedBaseBranch: string) {
  const draftSetupSnapshot = getDraftSetupSnapshot({ ...config, baseBranch: resolvedBaseBranch });
  try {
    await persistDraftSetupSnapshot(draftId, draftSetupSnapshot);
    return { draftSetupSnapshot, warning: null };
  } catch (err) {
    console.error('Failed to persist draft setup snapshot:', err);
    return {
      draftSetupSnapshot,
      warning: getDraftSetupPersistenceWarning(resolvedBaseBranch)
    };
  }
}

interface RepoChangeExecutionParams { newRepo: string; resolvedBaseBranch: string; config: PlannerConfig; draft: PlannerDraft | undefined; locationTodoIds?: string[]; navigate: ReturnType<typeof useNavigate>; onDraftCreated?: (draftId: string) => void; }

async function createDraftForRepoChange({ newRepo, resolvedBaseBranch, config, draft, locationTodoIds, navigate, onDraftCreated }: RepoChangeExecutionParams) {
  if (shouldSkipRepoDraftCreation(newRepo, resolvedBaseBranch, draft, config)) return false;
  const newDraft = await createDraft(newRepo, config.prompt.trim() || 'Untitled', { todoIds: locationTodoIds });
  const { draftSetupSnapshot, warning: baseBranchPersistenceWarning } = await persistDraftSetupWarning(newDraft.draft_id, config, resolvedBaseBranch);
  onDraftCreated?.(newDraft.draft_id);
  navigate(`/studio/${newDraft.draft_id}`, {
    replace: true,
    state: {
      initialDraft: constructDraftWithPlan(newDraft, draftSetupSnapshot),
      initialRepository: newRepo,
      initialBaseBranch: resolvedBaseBranch,
      baseBranchPersistenceWarning,
      todoIds: locationTodoIds
    }
  });

  return true;
}

function useSetupWizardConfig(draft: PlannerDraft | undefined, locationState: LocationState | undefined) {
  const savedSettings = useMemo(() => getPlannerSettings(), []);
  const draftContextConfig = (draft as DraftWithContextConfig | undefined)?.context_config;
  const initialConfiguredBaseBranch = draftContextConfig?.baseBranch ?? locationState?.initialBaseBranch ?? '';
  const [config, setConfig] = useState<PlannerConfig>(() => ({
    prompt: draft?.initial_prompt ?? locationState?.initialPrompt ?? '',
    baseBranch: initialConfiguredBaseBranch,
    granularity: draftContextConfig?.granularity ?? savedSettings.lastGranularity,
    contextLevel: draftContextConfig?.contextLevel ?? savedSettings.lastContextLevel,
    compress: draftContextConfig?.compress ?? false,
    files: ensureArray(draft?.attachments),
    contextRepositories: ensureArray(draftContextConfig?.contextRepositories),
    generationModel: draftContextConfig?.generationModel ?? null,
    manualFiles: ensureArray(draftContextConfig?.manualFiles),
    excludedFiles: ensureArray(draftContextConfig?.excludedFiles)
  }));

  return { config, setConfig, savedSettings, draftContextConfig, initialConfiguredBaseBranch };
}

interface SetupWizardLoadersParams {
  isNewMode: boolean;
  draft: PlannerDraft | undefined;
  locationState: LocationState | undefined;
  savedSettings: ReturnType<typeof getPlannerSettings>;
  config: PlannerConfig;
  setConfig: React.Dispatch<React.SetStateAction<PlannerConfig>>;
}

function useSetupWizardLoaders({ isNewMode, draft, locationState, savedSettings, config, setConfig }: SetupWizardLoadersParams) {
  const initialRepository = locationState?.initialRepository ?? savedSettings.lastRepository;
  const initialBaseBranch = locationState?.initialBaseBranch ?? savedSettings.lastBaseBranch;
  const repoLoader = useRepositoryLoader(true, initialRepository ?? undefined, initialBaseBranch ?? undefined);
  const newModeBranches = useBranchesLoader(isNewMode ? repoLoader.selectedRepo : '', repoLoader.selectedBaseBranch, setConfig);
  const repoInfo = useRepoInfoLoader(isNewMode, draft, setConfig);
  const agents = useAgentsLoader();
  const availableRepos = useIndexedRepositoriesLoader(draft?.repository, repoLoader.selectedRepo);

  usePlannerSettingsPersistence(
    config,
    draft?.repository,
    draft?.context_config?.baseBranch,
    repoLoader.selectedRepo,
    repoLoader.selectedBaseBranch
  );
  usePromptPersistence(draft?.draft_id, config.prompt, draft?.initial_prompt);
  useDraftSettingsPersistence(draft?.draft_id, config, draft);

  return { repoLoader, newModeBranches, repoInfo, agents, availableRepos };
}

function useRepoChangeInEditMode({ draft, config, locationTodoIds, navigate, onDraftCreated, setError, setIsCreating }: RepoChangeHandlerParams) {
  const requestIdRef = useRef(0);

  return useCallback(async (newRepo: string, selection?: RepoSelection) => {
    if (!newRepo) return;
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    setIsCreating(true);
    setError(null);
    try {
      const resolvedBaseBranch = await resolveRepoBaseBranch(newRepo, selection);
      if (!isLatestRepoChange(requestId, requestIdRef)) return;
      const didCreateDraft = await createDraftForRepoChange({ newRepo, resolvedBaseBranch, config, draft, locationTodoIds, navigate, onDraftCreated });
      if (!isLatestRepoChange(requestId, requestIdRef)) return;
      if (!didCreateDraft) {
        if (isLatestRepoChange(requestId, requestIdRef)) setIsCreating(false);
      }
    } catch (err) {
      if (!isLatestRepoChange(requestId, requestIdRef)) return;
      setError((err as Error).message || 'Failed to change repository');
      setIsCreating(false);
    }
  }, [config, draft, locationTodoIds, navigate, onDraftCreated, setError, setIsCreating]);
}

export const SetupWizard: React.FC<SetupWizardProps> = ({ draft, onGenerateComplete, onDraftCreated, onDraftCreatedInPlace }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const locationState = location.state as LocationState | undefined;
  const { addToast } = useToast();
  const isNewMode = !draft;
  const { config, setConfig, savedSettings, initialConfiguredBaseBranch } = useSetupWizardConfig(draft, locationState);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [branchError, setBranchError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  useDraftContextConfigSync(draft, setConfig);
  const { repoLoader, newModeBranches, repoInfo, agents, availableRepos } = useSetupWizardLoaders({
    isNewMode,
    draft,
    locationState,
    savedSettings,
    config,
    setConfig
  });
  const fileHandling = useFileHandling(isNewMode, draft, setConfig, setError);
  const handleGenerateComplete = useCallback(() => {
    addToast({ type: 'success', message: 'Plan generated successfully' });
    onGenerateComplete();
  }, [addToast, onGenerateComplete]);
  const draftId = draft?.draft_id ?? '';
  const generationPolling = useGenerationPolling({ draftId, onComplete: handleGenerateComplete });
  const contextExport = useContextExport(setError);
  const contextRefresh = useContextRefresh({ draftId, config, onBranchError: setBranchError });
  const previewTrace = usePreviewTrace(draft, draftId, contextRefresh.preview.isLoading);
  const setupSnapshot = useMemo(() => getDraftSetupSnapshot(config), [config]);
  const generationHandlers = useGenerationHandlers({ draft, config, branchError, contextHelpers: { isContextStale: contextRefresh.isContextStale, clearCountdown: contextRefresh.clearCountdown, fetchPreview: contextRefresh.fetchPreview },
    startPolling: generationPolling.startPolling, stopPolling: generationPolling.stopPolling, setError, setGenerationError: generationPolling.setGenerationError });
  const todoIds = locationState?.todoIds;
  const handleCreateDraftAndGenerate = useDraftCreation({
    selectedRepo: repoLoader.selectedRepo, config, localFiles: fileHandling.localFiles,
    onDraftCreated, navigate, setError, setIsCreating, todoIds
  });
  const { isAutoCreating, autoCreateError, autoCreateWarning } = useAutoDraftCreation({ isNewMode, selectedRepo: repoLoader.selectedRepo, resolvedBaseBranch: config.baseBranch, setupSnapshot, prompt: config.prompt, localFiles: fileHandling.localFiles, onDraftCreated, onDraftCreatedInPlace, navigate, todoIds });
  const autoResize = useAutoResize(textareaRef);
  const handleRepoChangeInEditMode = useRepoChangeInEditMode({ draft, config, locationTodoIds: locationState?.todoIds, navigate, onDraftCreated, setError, setIsCreating });
  const handleFileInputChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) { for (const file of Array.from(e.target.files)) await fileHandling.handleUpload(file); }
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [fileHandling]);
  const handleExportContext = useCallback(() => {
    if (!draft) return;
    contextExport.exportContext({ draftId: draft.draft_id, prompt: config.prompt, baseBranch: config.baseBranch, granularity: config.granularity, contextLevel: config.contextLevel, compress: config.compress, files: config.files });
  }, [contextExport, draft, config]);
  const handleGenerate = useCallback(async () => { await (isNewMode ? handleCreateDraftAndGenerate() : generationHandlers.handleGenerateForExistingDraft()); }, [isNewMode, handleCreateDraftAndGenerate, generationHandlers]);
  useSetupWizardEffects({ autoResize, prompt: config.prompt, generationError: generationPolling.generationError, repoLoadError: repoLoader.loadError, autoCreateError, autoCreateWarning, baseBranchPersistenceWarning: locationState?.baseBranchPersistenceWarning, addToast, setError });
  return (
    <SetupWizardContent
      isNewMode={isNewMode} draft={draft} config={config} setConfig={setConfig}
      repoLoader={repoLoader} newModeBranches={newModeBranches} repoInfo={repoInfo}
      fileHandling={fileHandling} generationPolling={generationPolling} contextExport={contextExport}
      contextRefresh={contextRefresh} generationHandlers={generationHandlers}
      autoResize={autoResize}
      textareaRef={textareaRef} fileInputRef={fileInputRef} error={error} branchError={branchError}
      isCreating={isCreating || isAutoCreating} initialConfiguredBaseBranch={initialConfiguredBaseBranch}
      handleRepoChangeInEditMode={handleRepoChangeInEditMode} handleFileInputChange={handleFileInputChange}
      handleExportContext={handleExportContext} handleGenerate={handleGenerate} agents={agents}
      availableRepos={availableRepos} previewTrace={previewTrace}
    />
  );
};

export default SetupWizard;
