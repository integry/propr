import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { PlannerDraft } from '../../api/gitfixApi';
import { getPlannerSettings } from '../../hooks/usePlannerSettings';
import { useGenerationPolling } from '../../hooks/useGenerationPolling';
import { useContextExport } from '../../hooks/useContextExport';
import { useContextRefresh } from '../../hooks/useContextRefresh';
import { useToast } from '../ui/useToast';
import { SetupWizardLeftPane } from './SetupWizardLeftPane';
import { SetupWizardRightPane } from './SetupWizardRightPane';
import {
  PlannerConfig,
  useRepositoryLoader,
  useRepoInfoLoader,
  useAgentsLoader,
  useIndexedRepositoriesLoader,
  usePlannerSettingsPersistence,
  useFileHandling,
  useGenerationHandlers,
  useDraftCreation,
  computeIsGenerateDisabled,
  computeCanExport
} from './setupWizardHooks';

interface SetupWizardProps {
  draft?: PlannerDraft;
  onGenerateComplete: () => void;
  onDraftCreated?: (draftId: string) => void;
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

  // Use extracted hooks for data loading
  const { repos, selectedRepo, setSelectedRepo, reposLoading, loadError: reposLoadError } =
    useRepositoryLoader(isNewMode, savedSettings.lastRepository);
  const repoInfo = useRepoInfoLoader(isNewMode, draft, setConfig);
  const agents = useAgentsLoader();

  // State
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(reposLoadError);
  const [branchError, setBranchError] = useState<string | null>(null);

  // Use extracted hooks
  const availableRepos = useIndexedRepositoriesLoader(draft?.repository, selectedRepo);
  usePlannerSettingsPersistence(config, draft?.repository, selectedRepo);
  const { localFiles, isUploading, handleUpload, handleRemoveFile, handleRemoveLocalFile, handlePaste } =
    useFileHandling(isNewMode, draft, setConfig, setError);

  const handleGenerateComplete = useCallback(() => {
    addToast({ type: 'success', message: 'Plan generated successfully' });
    onGenerateComplete();
  }, [addToast, onGenerateComplete]);

  const { isGenerating, generationTrace, generationError, startPolling, setGenerationError } =
    useGenerationPolling({ draftId: draft?.draft_id || '', onComplete: handleGenerateComplete });
  const { isExporting, exportContext } = useContextExport(setError);

  const { preview, isContextStale, fetchPreview, clearCountdown } =
    useContextRefresh({ draftId: draft?.draft_id || '', config, onBranchError: setBranchError });

  const { handleGenerateForExistingDraft, handleAbortGeneration } = useGenerationHandlers({
    draft, config, branchError, contextHelpers: { isContextStale, clearCountdown, fetchPreview }, startPolling, setError, setGenerationError
  });

  const handleCreateDraftAndGenerate = useDraftCreation({
    selectedRepo, config, localFiles, onDraftCreated, navigate, setError, setIsCreating
  });

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

  // Sync reposLoadError to error state
  useEffect(() => {
    if (reposLoadError) setError(reposLoadError);
  }, [reposLoadError]);

  const handleExportContext = useCallback(() => {
    if (!draft) return;
    exportContext({
      draftId: draft.draft_id, prompt: config.prompt, baseBranch: config.baseBranch,
      granularity: config.granularity, contextLevel: config.contextLevel, compress: config.compress, files: config.files
    });
  }, [exportContext, draft, config]);

  const handleGenerate = async () => {
    if (isNewMode) {
      await handleCreateDraftAndGenerate();
    } else {
      await handleGenerateForExistingDraft();
    }
  };

  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) await handleUpload(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const promptTrimmed = config.prompt.trim();
  const isGenerateDisabled = computeIsGenerateDisabled({
    isNewMode, isCreating, selectedRepo, promptTrimmed, reposLoading, isGenerating, branchError, repoInfoLoading: repoInfo.isLoading
  });
  const canExport = computeCanExport(isNewMode, promptTrimmed, config.baseBranch);

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
          isPreviewLoading={preview.isLoading}
          error={error}
          generationError={generationError}
          isGenerating={isGenerating}
          isCreating={isCreating}
          generationTrace={generationTrace}
          onAbort={handleAbortGeneration}
          granularity={config.granularity}
          onGranularityChange={(granularity) => setConfig(prev => ({ ...prev, granularity }))}
          contextFileCount={preview.data?.smartSelection?.length}
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
