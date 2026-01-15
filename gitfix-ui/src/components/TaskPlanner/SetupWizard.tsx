import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  uploadAttachment, 
  removeAttachment, 
  generatePlan, 
  getDraft, 
  previewContext,
  downloadContext,
  getRepositoryInfo,
  PlannerDraft, 
  PlannerAttachment, 
  GenerationTrace,
  Granularity,
  PreviewResult
} from '../../api/gitfixApi';
import { GenerationProgress } from './GenerationProgress';
import { CostPreview } from './CostPreview';
import { SmartFileSelection } from './SmartFileSelection';
import { AttachmentUploader } from './AttachmentUploader';
import { GranularitySelector } from './GranularitySelector';
import { ContextLevelSlider } from './ContextLevelSlider';
import { BranchSelector } from './BranchSelector';
import { Loader2, Download } from 'lucide-react';

interface SetupWizardProps {
  draft: PlannerDraft;
  onGenerateComplete: () => void;
}

const BRANCH_NAME_REGEX = /^[a-zA-Z0-9_\-./]+$/;
const DEBOUNCE_DELAY = 800;

interface PlannerConfig {
  prompt: string;
  baseBranch: string;
  granularity: Granularity;
  contextLevel: number;
  compress: boolean;
  files: PlannerAttachment[];
}

interface PreviewState {
  isLoading: boolean;
  data: PreviewResult | null;
  error: string | null;
  lastSynced: Date | null;
}

interface RepoInfoState {
  isLoading: boolean;
  branches: string[];
  error: string | null;
}

export const SetupWizard: React.FC<SetupWizardProps> = ({ draft, onGenerateComplete }) => {
  const [config, setConfig] = useState<PlannerConfig>({
    prompt: draft.initial_prompt || '',
    baseBranch: '',
    granularity: 'balanced',
    contextLevel: 50,
    compress: false,
    files: draft.attachments || []
  });
  
  const [preview, setPreview] = useState<PreviewState>({
    isLoading: false,
    data: null,
    error: null,
    lastSynced: null
  });

  const [repoInfo, setRepoInfo] = useState<RepoInfoState>({
    isLoading: true,
    branches: [],
    error: null
  });

  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [generationTrace, setGenerationTrace] = useState<GenerationTrace | undefined>(undefined);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [initialSyncDone, setInitialSyncDone] = useState<boolean>(false);
  
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const configRef = useRef(config);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  const autoResize = useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      // Reset height to auto to get the correct scrollHeight
      textarea.style.height = 'auto';
      // Set height to scrollHeight, with minimum of 120px (approximately 5 rows)
      const minHeight = 120;
      textarea.style.height = `${Math.max(textarea.scrollHeight, minHeight)}px`;
    }
  }, []);

  // Auto-resize textarea when prompt changes (handles initial content and programmatic changes)
  useEffect(() => {
    autoResize();
  }, [config.prompt, autoResize]);

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

  const fetchPreview = useCallback(async () => {
    const currentConfig = configRef.current;
    if (!currentConfig.prompt.trim() || !currentConfig.baseBranch) {
      return;
    }
    
    if (!BRANCH_NAME_REGEX.test(currentConfig.baseBranch)) {
      setBranchError('Invalid branch name format');
      return;
    }
    setBranchError(null);
    
    setPreview(prev => ({ ...prev, isLoading: true, error: null }));
    
    try {
      const result = await previewContext({
        draftId: draft.draft_id,
        prompt: currentConfig.prompt,
        baseBranch: currentConfig.baseBranch,
        granularity: currentConfig.granularity,
        contextLevel: currentConfig.contextLevel,
        compress: currentConfig.compress,
        files: currentConfig.files.map(f => f.originalName)
      });
      
      setPreview({
        isLoading: false,
        data: result,
        error: null,
        lastSynced: new Date()
      });
    } catch (err) {
      const errorMessage = (err as Error).message || 'Failed to fetch preview';
      setPreview(prev => ({
        ...prev,
        isLoading: false,
        error: errorMessage
      }));
      if (errorMessage.toLowerCase().includes('branch')) {
        setBranchError(errorMessage);
      }
    }
  }, [draft.draft_id]);

  useEffect(() => {
    if (!initialSyncDone && config.baseBranch && config.prompt.trim()) {
      setInitialSyncDone(true);
      fetchPreview();
    }
  }, [config.baseBranch, config.prompt, initialSyncDone, fetchPreview]);

  useEffect(() => {
    if (!initialSyncDone) return;

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    
    debounceTimerRef.current = setTimeout(() => {
      fetchPreview();
    }, DEBOUNCE_DELAY);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [config.prompt, config.baseBranch, config.granularity, config.contextLevel, config.compress, fetchPreview, initialSyncDone]);

  useEffect(() => {
    if (initialSyncDone && config.files.length > 0) {
      fetchPreview();
    }
  }, [config.files.length, fetchPreview, initialSyncDone]);

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

  const handleExportContext = async () => {
    if (!config.prompt.trim() || !config.baseBranch) {
      setError('Please provide a prompt and select a branch before exporting');
      return;
    }
    
    setIsExporting(true);
    setError(null);
    
    try {
      const blob = await downloadContext({
        draftId: draft.draft_id,
        prompt: config.prompt,
        baseBranch: config.baseBranch,
        granularity: config.granularity,
        contextLevel: config.contextLevel,
        compress: config.compress,
        files: config.files.map(f => f.originalName)
      });
      
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `context-${draft.draft_id}.xml`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err) {
      setError((err as Error).message || 'Failed to export context');
    } finally {
      setIsExporting(false);
    }
  };

  const handleGenerate = async () => {
    if (branchError) {
      setError('Please fix the branch name before generating');
      return;
    }

    setIsGenerating(true);
    setError(null);
    setGenerationTrace(undefined);

    try {
      // Start generation - returns immediately with 202
      await generatePlan(draft.draft_id, {
        baseBranch: config.baseBranch,
        granularity: config.granularity,
        contextLevel: config.contextLevel,
        compress: config.compress
      });
    } catch (err) {
      setError((err as Error).message || 'Failed to start plan generation');
      setIsGenerating(false);
      return;
    }

    // Poll for completion
    pollingIntervalRef.current = setInterval(async () => {
      try {
        const updatedDraft = await getDraft(draft.draft_id);
        if (updatedDraft.generation_trace) {
          setGenerationTrace(updatedDraft.generation_trace);
          // Check for error in generation trace
          const trace = updatedDraft.generation_trace as GenerationTrace & { error?: string };
          if (trace.error) {
            if (pollingIntervalRef.current) {
              clearInterval(pollingIntervalRef.current);
              pollingIntervalRef.current = null;
            }
            setError(trace.error);
            setIsGenerating(false);
            return;
          }
        }
        // Check if generation completed (status changed to 'review')
        if (updatedDraft.status === 'review') {
          if (pollingIntervalRef.current) {
            clearInterval(pollingIntervalRef.current);
            pollingIntervalRef.current = null;
          }
          onGenerateComplete();
        }
        // Check if generation failed (status went back to 'draft')
        if (updatedDraft.status === 'draft') {
          if (pollingIntervalRef.current) {
            clearInterval(pollingIntervalRef.current);
            pollingIntervalRef.current = null;
          }
          const trace = updatedDraft.generation_trace as GenerationTrace & { error?: string };
          setError(trace?.error || 'Plan generation failed');
          setIsGenerating(false);
        }
      } catch (e) {
        console.error('Failed to poll draft status:', e);
      }
    }, 1000);
  };

  useEffect(() => {
    return () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
      }
    };
  }, []);

  const isGenerateDisabled = isGenerating || preview.isLoading || !!branchError || repoInfo.isLoading;

  return (
    <div className="max-w-4xl mx-auto p-6 bg-white rounded-lg shadow">
      <div className="flex justify-between items-start mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 mb-2">Configure AI Planner</h2>
          <p className="text-gray-600">
            Repository: <span className="font-mono text-gray-900">{draft.repository}</span>
          </p>
        </div>
        <BranchSelector
          value={config.baseBranch}
          branches={repoInfo.branches}
          isLoading={repoInfo.isLoading}
          error={branchError || repoInfo.error}
          onChange={(branch) => setConfig(prev => ({ ...prev, baseBranch: branch }))}
        />
      </div>

      <div className="mb-6">
        <label className="block text-sm font-medium text-gray-700 mb-2">Prompt</label>
        <textarea
          ref={textareaRef}
          value={config.prompt}
          onChange={(e) => setConfig(prev => ({ ...prev, prompt: e.target.value }))}
          onInput={autoResize}
          placeholder="Describe what you want the AI to do..."
          className="w-full px-4 py-3 border border-gray-300 rounded-md focus:ring-indigo-500 focus:border-indigo-500 resize-none overflow-hidden"
          style={{ minHeight: '120px' }}
        />
      </div>

      <GranularitySelector
        value={config.granularity}
        onChange={(granularity) => setConfig(prev => ({ ...prev, granularity }))}
      />

      <ContextLevelSlider
        value={config.contextLevel}
        onChange={(contextLevel) => setConfig(prev => ({ ...prev, contextLevel }))}
        compress={config.compress}
        onCompressChange={(compress) => setConfig(prev => ({ ...prev, compress }))}
      />

      <CostPreview preview={preview} />

      <div className="flex justify-end mb-4">
        <button
          onClick={handleExportContext}
          disabled={isExporting || preview.isLoading || !config.prompt.trim() || !config.baseBranch}
          className="text-sm text-indigo-600 hover:text-indigo-800 font-medium flex items-center gap-1 disabled:text-gray-400 disabled:cursor-not-allowed"
        >
          {isExporting ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Download className="w-4 h-4" />
          )}
          Export Context (XML)
        </button>
      </div>

      {preview.data && (
        <SmartFileSelection smartSelection={preview.data.smartSelection} />
      )}

      <AttachmentUploader
        files={config.files}
        draftId={draft.draft_id}
        isUploading={isUploading}
        onUpload={handleUpload}
        onRemove={handleRemoveFile}
      />

      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-md text-red-700">
          {error}
        </div>
      )}

      {isGenerating && <GenerationProgress trace={generationTrace} />}

      <button 
        onClick={handleGenerate}
        disabled={isGenerateDisabled}
        className={`w-full py-3 rounded-lg font-medium transition-colors ${
          isGenerateDisabled
            ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
            : 'bg-indigo-600 text-white hover:bg-indigo-700 cursor-pointer'
        }`}
      >
        {isGenerating ? (
          <span className="flex items-center justify-center gap-2">
            <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            Generating Plan...
          </span>
        ) : preview.isLoading ? (
          <span className="flex items-center justify-center gap-2">
            <Loader2 className="w-5 h-5 animate-spin" />
            Syncing...
          </span>
        ) : repoInfo.isLoading ? (
          <span className="flex items-center justify-center gap-2">
            <Loader2 className="w-5 h-5 animate-spin" />
            Loading repository info...
          </span>
        ) : (
          'Generate Implementation Plan'
        )}
      </button>
    </div>
  );
};

export default SetupWizard;
