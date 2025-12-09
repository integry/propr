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
import { Square, Layers, LayoutGrid, Loader2 } from 'lucide-react';

interface SetupWizardProps {
  draft: PlannerDraft;
  onGenerateComplete: () => void;
}

const MAX_IMAGE_SIZE = 1024;
const BRANCH_NAME_REGEX = /^[a-zA-Z0-9_\-./]+$/;
const DEBOUNCE_DELAY = 800;

const GRANULARITY_OPTIONS: Array<{
  id: Granularity;
  label: string;
  description: string;
  icon: typeof Square;
}> = [
  { 
    id: 'single', 
    label: 'Single Task', 
    description: 'Consolidate all changes into one large GitHub issue.',
    icon: Square 
  },
  { 
    id: 'balanced', 
    label: 'Balanced', 
    description: 'Group related changes logically. (Recommended)',
    icon: Layers 
  },
  { 
    id: 'granular', 
    label: 'Granular', 
    description: 'Create a separate issue for every modified file.',
    icon: LayoutGrid 
  }
];

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

const resizeImage = (file: File): Promise<File> => {
  return new Promise((resolve) => {
    if (!file.type.startsWith('image/') || file.size <= 1024 * 1024) {
      resolve(file);
      return;
    }

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const img = new Image();
    
    img.onload = () => {
      let { width, height } = img;
      
      if (width > MAX_IMAGE_SIZE || height > MAX_IMAGE_SIZE) {
        if (width > height) {
          height = (height / width) * MAX_IMAGE_SIZE;
          width = MAX_IMAGE_SIZE;
        } else {
          width = (width / height) * MAX_IMAGE_SIZE;
          height = MAX_IMAGE_SIZE;
        }
      }
      
      canvas.width = width;
      canvas.height = height;
      ctx?.drawImage(img, 0, 0, width, height);
      
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(new File([blob], file.name, { type: file.type }));
        } else {
          resolve(file);
        }
      }, file.type, 0.9);
    };
    
    img.onerror = () => resolve(file);
    img.src = URL.createObjectURL(file);
  });
};

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
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchPreview = useCallback(async (currentConfig: PlannerConfig) => {
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
      fetchPreview(config);
    }, DEBOUNCE_DELAY);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [config.prompt, config.baseBranch, config.granularity, fetchPreview]);

  useEffect(() => {
    if (config.files.length > 0) {
      fetchPreview(config);
    }
  }, [config.files.length]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    setError(null);
    
    try {
      const processedFile = await resizeImage(file);
      const attachment = await uploadAttachment(draft.draft_id, processedFile);
      setConfig(prev => ({ ...prev, files: [...prev.files, attachment] }));
    } catch (err) {
      setError((err as Error).message || 'Failed to upload file');
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
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

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (!file) return;

    setIsUploading(true);
    setError(null);
    
    try {
      const processedFile = await resizeImage(file);
      const attachment = await uploadAttachment(draft.draft_id, processedFile);
      setConfig(prev => ({ ...prev, files: [...prev.files, attachment] }));
    } catch (err) {
      setError((err as Error).message || 'Failed to upload file');
    } finally {
      setIsUploading(false);
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  };

  const getCostColorClass = (cost: number) => {
    if (cost > 0.5) return 'bg-red-50 text-red-700 border-red-200';
    if (cost > 0.1) return 'bg-yellow-50 text-yellow-700 border-yellow-200';
    return 'bg-green-50 text-green-700 border-green-200';
  };

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

      <div className="mb-6">
        <label className="block text-sm font-medium text-gray-700 mb-3">Task Granularity</label>
        <div className="flex gap-2">
          {GRANULARITY_OPTIONS.map((option) => {
            const Icon = option.icon;
            const isSelected = config.granularity === option.id;
            return (
              <button
                key={option.id}
                onClick={() => setConfig(prev => ({ ...prev, granularity: option.id }))}
                className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-lg border-2 transition-all ${
                  isSelected
                    ? 'border-indigo-600 bg-indigo-50 text-indigo-700'
                    : 'border-gray-200 hover:border-gray-300 text-gray-600'
                }`}
                title={option.description}
              >
                <Icon className="w-4 h-4" />
                <span className="font-medium text-sm">{option.label}</span>
              </button>
            );
          })}
        </div>
        <p className="text-xs text-gray-500 mt-2">
          {GRANULARITY_OPTIONS.find(o => o.id === config.granularity)?.description}
        </p>
      </div>

      <div className={`mb-6 p-4 rounded-md border transition-opacity ${
        preview.isLoading ? 'opacity-60' : ''
      } ${preview.data ? getCostColorClass(preview.data.stats.costEstimate) : 'bg-gray-50 border-gray-200'}`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            {preview.isLoading ? (
              <span className="flex items-center gap-2 text-gray-500">
                <Loader2 className="w-4 h-4 animate-spin" />
                Analyzing...
              </span>
            ) : preview.data ? (
              <>
                <span className="font-bold">Est. Cost: ${preview.data.stats.costEstimate.toFixed(3)}</span>
                <span>({preview.data.stats.totalTokens.toLocaleString()} tokens)</span>
              </>
            ) : preview.error ? (
              <span className="text-red-600">{preview.error}</span>
            ) : (
              <span className="text-gray-500">Enter a prompt to see cost estimate</span>
            )}
          </div>
          {preview.data && preview.data.smartSelection.length > 0 && (
            <span className="text-sm bg-indigo-100 text-indigo-700 px-3 py-1 rounded-full">
              Auto-selected {preview.data.smartSelection.filter(f => f.source === 'auto').length} relevant files
            </span>
          )}
        </div>
        
        {preview.data && preview.data.warnings.length > 0 && (
          <div className="mt-2 text-sm text-yellow-600">
            {preview.data.warnings.map((warning, idx) => (
              <p key={idx}>⚠️ {warning}</p>
            ))}
          </div>
        )}
      </div>

      {preview.data && preview.data.smartSelection.length > 0 && (
        <div className="mb-6">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Smart File Selection ({preview.data.smartSelection.length} files)
          </label>
          <div className="max-h-48 overflow-y-auto border border-gray-200 rounded-md">
            <ul className="divide-y divide-gray-100">
              {preview.data.smartSelection.slice(0, 20).map((file, idx) => (
                <li key={idx} className="px-3 py-2 text-sm flex items-center justify-between hover:bg-gray-50">
                  <div className="flex items-center gap-2">
                    <span className={`text-xs px-1.5 py-0.5 rounded ${
                      file.source === 'manual' 
                        ? 'bg-blue-100 text-blue-700' 
                        : 'bg-green-100 text-green-700'
                    }`}>
                      {file.source}
                    </span>
                    <span className="font-mono text-gray-900">{file.path}</span>
                  </div>
                  <span className="text-xs text-gray-500 truncate max-w-xs" title={file.reason}>
                    {file.reason}
                  </span>
                </li>
              ))}
              {preview.data.smartSelection.length > 20 && (
                <li className="px-3 py-2 text-sm text-gray-500 text-center">
                  ... and {preview.data.smartSelection.length - 20} more files
                </li>
              )}
            </ul>
          </div>
        </div>
      )}

      <div className="mb-8">
        <label className="block text-sm font-medium text-gray-700 mb-2">Attachments</label>
        <div 
          className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center hover:bg-gray-50 transition-colors"
          onDrop={handleDrop}
          onDragOver={handleDragOver}
        >
          <input 
            type="file" 
            onChange={handleFileChange} 
            className="hidden" 
            id="file-upload" 
            ref={fileInputRef}
            accept="image/*,.log,.txt,.json"
          />
          <label 
            htmlFor="file-upload" 
            className={`cursor-pointer text-indigo-600 hover:text-indigo-500 ${isUploading ? 'opacity-50' : ''}`}
          >
            {isUploading ? 'Uploading...' : 'Upload logs or screenshots (drag & drop supported)'}
          </label>
          <p className="text-xs text-gray-400 mt-2">Images over 1MB will be automatically resized</p>
        </div>
        {config.files.length > 0 && (
          <ul className="mt-4 space-y-2">
            {config.files.map(f => (
              <li key={f.id} className="text-sm flex items-center justify-between bg-gray-50 p-3 rounded-md">
                <div className="flex items-center gap-2">
                  <span>📄</span>
                  <span className="text-gray-900">{f.originalName}</span>
                  <span className="text-xs text-gray-400">({f.tokenEstimate} tokens)</span>
                </div>
                <button
                  onClick={() => handleRemoveFile(f.id)}
                  className="text-red-600 hover:text-red-700 text-xs font-medium"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

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
