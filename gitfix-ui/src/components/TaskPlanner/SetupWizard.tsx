import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, Loader2, Sparkles, ChevronDown } from 'lucide-react';
import { PlannerDraft, createDraft, Granularity } from '../../api/gitfixApi';
import { getPlannerSettings } from '../../hooks/usePlannerSettings';
import { useGenerationPolling } from '../../hooks/useGenerationPolling';
import { useContextExport } from '../../hooks/useContextExport';
import { useContextRefresh } from '../../hooks/useContextRefresh';
import { useToast } from '../ui/useToast';
import { SetupWizardLeftPane } from './SetupWizardLeftPane';
import { SetupWizardRightPane } from './SetupWizardRightPane';
import { GranularityPills } from './ComposerControls';
import { ProviderLogo } from '../ui/ProviderLogo';
import { MODEL_INFO_MAP } from '../../config/modelDefinitions';
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
  computeIsGenerateDisabled,
  computeCanExport,
  useAutoResize
} from './setupWizardHooks';

// Get estimated issue count based on granularity setting
const getEstimatedIssueText = (granularity: Granularity): string => {
  const counts: Record<Granularity, string> = {
    single: '1',
    balanced: '3-5',
    granular: '5-10',
  };
  const count = counts[granularity] || '1';
  return `${count} ${count === '1' ? 'issue' : 'issues'}`;
};

// Generate button content - extracted to reduce cyclomatic complexity
const GenerateButtonContent: React.FC<{
  isNewMode: boolean;
  isCreating: boolean;
  isGenerating: boolean;
}> = ({ isNewMode, isCreating, isGenerating }) => {
  if (isNewMode && isCreating) {
    return (
      <>
        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
        <span>Creating...</span>
      </>
    );
  }
  if (!isNewMode && isGenerating) {
    return (
      <>
        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
        <span>Generating...</span>
      </>
    );
  }
  return (
    <>
      <Sparkles className="w-4 h-4" />
      <span>Generate Plan</span>
    </>
  );
};

interface SetupWizardProps {
  draft?: PlannerDraft;
  onGenerateComplete: () => void;
  onDraftCreated?: (draftId: string) => void;
}

// Content component handles rendering while SetupWizard handles state/hooks
// This split reduces cyclomatic complexity to comply with ESLint rules
const SetupWizardContent: React.FC<{
  isNewMode: boolean;
  draft: PlannerDraft | undefined;
  config: PlannerConfig;
  setConfig: React.Dispatch<React.SetStateAction<PlannerConfig>>;
  repoLoader: ReturnType<typeof useRepositoryLoader>;
  newModeBranches: ReturnType<typeof useBranchesLoader>;
  repoInfo: ReturnType<typeof useRepoInfoLoader>;
  fileHandling: ReturnType<typeof useFileHandling>;
  generationPolling: ReturnType<typeof useGenerationPolling>;
  contextExport: ReturnType<typeof useContextExport>;
  contextRefresh: ReturnType<typeof useContextRefresh>;
  generationHandlers: ReturnType<typeof useGenerationHandlers>;
  handleCreateDraftAndGenerate: () => Promise<void>;
  autoResize: () => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  error: string | null;
  branchError: string | null;
  isChangingRepo: boolean;
  isCreating: boolean;
  setIsChangingRepo: React.Dispatch<React.SetStateAction<boolean>>;
  handleRepoChangeInEditMode: (repo: string) => Promise<void>;
  handleFileInputChange: (e: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  handleExportContext: () => void;
  handleGenerate: () => Promise<void>;
  agents: ReturnType<typeof useAgentsLoader>;
}> = (props) => {
  const {
    isNewMode, draft, config, setConfig, repoLoader, newModeBranches, repoInfo,
    fileHandling, generationPolling, contextExport, contextRefresh, generationHandlers,
    autoResize, textareaRef, fileInputRef, error, branchError, isChangingRepo, isCreating,
    setIsChangingRepo, handleRepoChangeInEditMode, handleFileInputChange, handleExportContext,
    handleGenerate, agents
  } = props;

  // Pre-computed values to reduce ternaries in JSX
  const repository = draft?.repository ?? repoLoader.selectedRepo;
  const branches = isNewMode ? newModeBranches.branches : repoInfo.branches;
  const isRepoLoading = isNewMode ? newModeBranches.isLoading : repoInfo.isLoading;
  const repoError = isNewMode ? newModeBranches.error : repoInfo.error;
  const onRepoChange = isNewMode ? repoLoader.setSelectedRepo : handleRepoChangeInEditMode;

  const promptTrimmed = config.prompt.trim();
  const isGenerateDisabled = computeIsGenerateDisabled({
    isNewMode, isCreating, selectedRepo: repoLoader.selectedRepo, promptTrimmed,
    reposLoading: repoLoader.reposLoading, isGenerating: generationPolling.isGenerating,
    branchError, repoInfoLoading: repoInfo.isLoading
  });
  const canExport = computeCanExport(isNewMode, promptTrimmed, config.baseBranch);

  // Model selection derived values
  const enabledAgents = agents.filter(agent => agent.enabled);
  const selectedAgent = config.generationModel?.includes(':')
    ? config.generationModel.split(':')[0]
    : config.generationModel;

  const modelOptions = enabledAgents.flatMap(agent =>
    (agent.supportedModels || []).map(modelId => ({
      value: `${agent.alias}:${modelId}`,
      label: `${agent.alias} / ${MODEL_INFO_MAP[modelId]?.name || modelId}`,
      agent: agent.alias
    }))
  );

  const handleModelSelectChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newValue = e.target.value || null;
    setConfig(prev => ({ ...prev, generationModel: newValue }));
  };

  const isGenerating = generationPolling.isGenerating;
  const stats = contextRefresh.preview.data?.stats;

  return (
    <div className="h-full flex flex-col bg-white">
      <div className="flex-1 flex min-h-0">
        <SetupWizardLeftPane
          isNewMode={isNewMode}
          repository={repository}
          repos={repoLoader.repos}
          selectedRepo={repoLoader.selectedRepo}
          onRepoChange={onRepoChange}
          reposLoading={repoLoader.reposLoading}
          baseBranch={config.baseBranch}
          branches={branches}
          isRepoLoading={isRepoLoading}
          branchError={branchError}
          repoError={repoError}
          onBranchChange={(branch) => setConfig(prev => ({ ...prev, baseBranch: branch }))}
          isChangingRepo={isChangingRepo}
          onChangeRepoClick={() => setIsChangingRepo(true)}
          prompt={config.prompt}
          onPromptChange={(prompt) => setConfig(prev => ({ ...prev, prompt }))}
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
        />
        <SetupWizardRightPane
          contextLevel={config.contextLevel}
          onContextLevelChange={(contextLevel) => setConfig(prev => ({ ...prev, contextLevel }))}
          smartSelection={contextRefresh.preview.data?.smartSelection}
          isPreviewLoading={contextRefresh.preview.isLoading}
          stats={stats}
        />
      </div>

      {/* Unified Footer Bar */}
      <div className="bg-white px-6 py-4" style={{ borderTop: '1px solid #e5e7eb' }}>
        <div className="flex items-center justify-between gap-4">
          {/* Left side: Granularity + Generate */}
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-3">
              <span className="text-sm text-gray-500 whitespace-nowrap">Break plan into issues:</span>
              <GranularityPills
                value={config.granularity}
                onChange={(granularity) => setConfig(prev => ({ ...prev, granularity }))}
                hideEstimate
              />
              <span className="text-xs text-gray-400">{getEstimatedIssueText(config.granularity)}</span>
            </div>
            <button
              onClick={handleGenerate}
              disabled={isGenerateDisabled}
              className="flex items-center gap-2 px-6 py-2.5 bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
            >
              <GenerateButtonContent isNewMode={isNewMode} isCreating={isCreating} isGenerating={isGenerating} />
            </button>
          </div>

          {/* Right side: Model + Export */}
          <div className="flex items-center gap-4">
            {enabledAgents.length > 0 && (
              <div className="flex items-center gap-2 text-sm text-gray-600">
                <span className="text-gray-500">Model:</span>
                <div className="relative inline-flex items-center max-w-[200px]">
                  {selectedAgent && (
                    <ProviderLogo
                      provider={selectedAgent}
                      className="w-4 h-4 absolute left-2 pointer-events-none z-10"
                    />
                  )}
                  <select
                    value={config.generationModel || ''}
                    onChange={handleModelSelectChange}
                    className={`appearance-none bg-white border border-gray-200 rounded-md text-sm py-1.5 pr-7 text-gray-700 hover:border-gray-300 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 cursor-pointer transition-colors truncate w-full ${selectedAgent ? 'pl-7' : 'pl-2.5'}`}
                    title="Select AI model for plan generation"
                  >
                    <option value="">{stats?.modelName ? `${stats.modelName} (default)` : 'Default model'}</option>
                    {modelOptions.map(opt => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="w-4 h-4 text-gray-400 absolute right-2 pointer-events-none" />
                </div>
              </div>
            )}
            <button
              onClick={handleExportContext}
              disabled={contextExport.isExporting || contextRefresh.preview.isLoading || !canExport}
              className="flex items-center gap-1.5 px-3 py-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-md disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
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

// Main component - handles state and hooks
export const SetupWizard: React.FC<SetupWizardProps> = ({ draft, onGenerateComplete, onDraftCreated }) => {
  const navigate = useNavigate();
  const savedSettings = useMemo(() => getPlannerSettings(), []);
  const { addToast } = useToast();
  const isNewMode = !draft;

  const [config, setConfig] = useState<PlannerConfig>(() => ({
    prompt: draft?.initial_prompt ?? '',
    baseBranch: '',
    granularity: savedSettings.lastGranularity,
    contextLevel: savedSettings.lastContextLevel,
    compress: false,
    files: draft?.attachments ?? [],
    contextRepositories: [],
    generationModel: null
  }));

  const [isChangingRepo, setIsChangingRepo] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [branchError, setBranchError] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Data loading hooks
  const repoLoader = useRepositoryLoader(isNewMode || isChangingRepo, savedSettings.lastRepository ?? undefined);
  const newModeBranches = useBranchesLoader(isNewMode ? repoLoader.selectedRepo : '', setConfig);
  const repoInfo = useRepoInfoLoader(isNewMode, draft, setConfig);
  const agents = useAgentsLoader();
  const availableRepos = useIndexedRepositoriesLoader(draft?.repository, repoLoader.selectedRepo);

  // Persistence and file handling
  usePlannerSettingsPersistence(config, draft?.repository, repoLoader.selectedRepo);
  const fileHandling = useFileHandling(isNewMode, draft, setConfig, setError);

  // Generation complete callback
  const handleGenerateComplete = useCallback(() => {
    addToast({ type: 'success', message: 'Plan generated successfully' });
    onGenerateComplete();
  }, [addToast, onGenerateComplete]);

  // Generation and context hooks
  const draftId = draft?.draft_id ?? '';
  const generationPolling = useGenerationPolling({ draftId, onComplete: handleGenerateComplete });
  const contextExport = useContextExport(setError);
  const contextRefresh = useContextRefresh({ draftId, config, onBranchError: setBranchError });

  const generationHandlers = useGenerationHandlers({
    draft, config, branchError,
    contextHelpers: { isContextStale: contextRefresh.isContextStale, clearCountdown: contextRefresh.clearCountdown, fetchPreview: contextRefresh.fetchPreview },
    startPolling: generationPolling.startPolling, setError, setGenerationError: generationPolling.setGenerationError
  });

  const handleCreateDraftAndGenerate = useDraftCreation({
    selectedRepo: repoLoader.selectedRepo, config, localFiles: fileHandling.localFiles,
    onDraftCreated, navigate, setError, setIsCreating
  });

  const autoResize = useAutoResize(textareaRef);

  // Handlers
  const handleRepoChangeInEditMode = useCallback(async (newRepo: string) => {
    if (!newRepo || newRepo === draft?.repository) { setIsChangingRepo(false); return; }
    setIsCreating(true);
    setError(null);
    try {
      const newDraft = await createDraft(newRepo, config.prompt.trim() || 'Untitled');
      onDraftCreated?.(newDraft.draft_id);
      navigate(`/studio/${newDraft.draft_id}`, { replace: true });
    } catch (err) {
      setError((err as Error).message || 'Failed to change repository');
      setIsCreating(false);
      setIsChangingRepo(false);
    }
  }, [draft?.repository, config.prompt, onDraftCreated, navigate]);

  const handleFileInputChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files?.length) { for (const file of Array.from(files)) await fileHandling.handleUpload(file); }
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [fileHandling]);

  const handleExportContext = useCallback(() => {
    if (!draft) return;
    contextExport.exportContext({
      draftId: draft.draft_id, prompt: config.prompt, baseBranch: config.baseBranch,
      granularity: config.granularity, contextLevel: config.contextLevel, compress: config.compress, files: config.files
    });
  }, [contextExport, draft, config]);

  const handleGenerate = useCallback(async () => {
    await (isNewMode ? handleCreateDraftAndGenerate() : generationHandlers.handleGenerateForExistingDraft());
  }, [isNewMode, handleCreateDraftAndGenerate, generationHandlers]);

  // Effects
  useEffect(() => { autoResize(); }, [config.prompt, autoResize]);
  useEffect(() => { if (generationPolling.generationError) addToast({ type: 'error', message: `Plan generation failed: ${generationPolling.generationError}` }); }, [generationPolling.generationError, addToast]);
  useEffect(() => { if (repoLoader.loadError) setError(repoLoader.loadError); }, [repoLoader.loadError]);

  void availableRepos; // Suppress unused variable warning

  return (
    <SetupWizardContent
      isNewMode={isNewMode} draft={draft} config={config} setConfig={setConfig}
      repoLoader={repoLoader} newModeBranches={newModeBranches} repoInfo={repoInfo}
      fileHandling={fileHandling} generationPolling={generationPolling} contextExport={contextExport}
      contextRefresh={contextRefresh} generationHandlers={generationHandlers}
      handleCreateDraftAndGenerate={handleCreateDraftAndGenerate} autoResize={autoResize}
      textareaRef={textareaRef} fileInputRef={fileInputRef} error={error} branchError={branchError}
      isChangingRepo={isChangingRepo} isCreating={isCreating} setIsChangingRepo={setIsChangingRepo}
      handleRepoChangeInEditMode={handleRepoChangeInEditMode} handleFileInputChange={handleFileInputChange}
      handleExportContext={handleExportContext} handleGenerate={handleGenerate} agents={agents}
    />
  );
};

export default SetupWizard;
