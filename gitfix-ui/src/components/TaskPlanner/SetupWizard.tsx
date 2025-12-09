import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  uploadAttachment, 
  removeAttachment, 
  generatePlan, 
  getDraft, 
  previewContext,
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
import { Loader2 } from 'lucide-react';

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
  files: PlannerAttachment[];
}

interface PreviewState {
  isLoading: boolean;
  data: PreviewResult | null;
  error: string | null;
  lastSynced: Date | null;
}

export const SetupWizard: React.FC<SetupWizardProps> = ({ draft, onGenerateComplete }) => {
  const [config, setConfig] = useState<PlannerConfig>({
    prompt: draft.prompt,
    baseBranch: 'main',
    granularity: 'balanced',
    files: draft.attachments || []
  });
  
  const [preview, setPreview] = useState<PreviewState>({
    isLoading: false,
    data: null,
    error: null,
    lastSynced: null
  });

  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [generationTrace, setGenerationTrace] = useState<GenerationTrace | undefined>(undefined);
  const [branchError, setBranchError] = useState<string | null>(null);
  
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const configRef = useRef(config);

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  const fetchPreview = useCallback(async () => {
    const currentConfig = configRef.current;
    if (!currentConfig.prompt.trim()) {
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
  }, [config.prompt, config.baseBranch, config.granularity, fetchPreview]);

  useEffect(() => {
    if (config.files.length > 0) {
      fetchPreview();
    }
  }, [config.files.length, fetchPreview]);

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

  const handleGenerate = async () => {
    if (branchError) {
      setError('Please fix the branch name before generating');
      return;
    }
    
    setIsGenerating(true);
    setError(null);
    setGenerationTrace(undefined);
    
    const generatePromise = generatePlan(draft.draft_id, {
      baseBranch: config.baseBranch,
      granularity: config.granularity
    });
    
    pollingIntervalRef.current = setInterval(async () => {
      try {
        const updatedDraft = await getDraft(draft.draft_id);
        if (updatedDraft.generation_trace) {
          setGenerationTrace(updatedDraft.generation_trace);
        }
        if (updatedDraft.status !== 'draft' && updatedDraft.status !== 'generating') {
          if (pollingIntervalRef.current) {
            clearInterval(pollingIntervalRef.current);
            pollingIntervalRef.current = null;
          }
        }
      } catch (e) {
        console.error('Failed to poll draft status:', e);
      }
    }, 1000);

    try {
      await generatePromise;
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }
      const finalDraft = await getDraft(draft.draft_id);
      if (finalDraft.generation_trace) {
        setGenerationTrace(finalDraft.generation_trace);
      }
      onGenerateComplete();
    } catch (err) {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }
      setError((err as Error).message || 'Failed to generate plan');
      setIsGenerating(false);
    }
  };

  useEffect(() => {
    return () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
      }
    };
  }, []);

  const isGenerateDisabled = isGenerating || preview.isLoading || !!branchError;

  return (
    <div className="max-w-4xl mx-auto p-6 bg-white rounded-lg shadow">
      <div className="flex justify-between items-start mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 mb-2">Configure AI Planner</h2>
          <p className="text-gray-600">
            Repository: <span className="font-mono text-gray-900">{draft.repository}</span>
          </p>
        </div>
        <div className="flex flex-col items-end">
          <label className="block text-sm font-medium text-gray-700 mb-1">Base Branch</label>
          <input
            type="text"
            value={config.baseBranch}
            onChange={(e) => setConfig(prev => ({ ...prev, baseBranch: e.target.value }))}
            placeholder="main"
            className={`w-40 px-3 py-1.5 text-sm border rounded-md font-mono ${
              branchError 
                ? 'border-red-300 focus:ring-red-500 focus:border-red-500' 
                : 'border-gray-300 focus:ring-indigo-500 focus:border-indigo-500'
            }`}
          />
          {branchError && (
            <p className="text-xs text-red-600 mt-1">{branchError}</p>
          )}
        </div>
      </div>

      <div className="mb-6">
        <label className="block text-sm font-medium text-gray-700 mb-2">Prompt</label>
        <textarea
          value={config.prompt}
          onChange={(e) => setConfig(prev => ({ ...prev, prompt: e.target.value }))}
          placeholder="Describe what you want the AI to do..."
          className="w-full px-4 py-3 border border-gray-300 rounded-md focus:ring-indigo-500 focus:border-indigo-500 resize-none"
          rows={4}
          style={{ minHeight: '100px' }}
        />
      </div>

      <GranularitySelector
        value={config.granularity}
        onChange={(granularity) => setConfig(prev => ({ ...prev, granularity }))}
      />

      <CostPreview preview={preview} />

      {preview.data && (
        <SmartFileSelection smartSelection={preview.data.smartSelection} />
      )}

      <AttachmentUploader
        files={config.files}
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
        ) : (
          'Generate Implementation Plan'
        )}
      </button>
    </div>
  );
};

export default SetupWizard;
