import React, { useState, useEffect, useRef, useCallback } from 'react';
import { getContextStats, uploadAttachment, removeAttachment, generatePlan, getDraft, PlannerDraft, PlannerAttachment, ContextStats, GenerationTrace } from '../../api/gitfixApi';
import { GenerationProgress } from './GenerationProgress';

interface SetupWizardProps {
  draft: PlannerDraft;
  onGenerateComplete: () => void;
}

const CONTEXT_LEVELS = ['low', 'medium', 'high'] as const;
const CONTEXT_LABELS = ['Structure Only (Fast)', 'Balanced (Recommended)', 'Full Context (Expensive)'];
const MAX_IMAGE_SIZE = 1024;

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
  const [levelIndex, setLevelIndex] = useState<number>(1);
  const [stats, setStats] = useState<ContextStats | null>(null);
  const [files, setFiles] = useState<PlannerAttachment[]>(draft.attachments || []);
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [generationTrace, setGenerationTrace] = useState<GenerationTrace | undefined>(undefined);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStats = useCallback(async (level: string) => {
    try {
      const data = await getContextStats(draft.draft_id, { level });
      setStats(data);
    } catch (err) {
      console.error('Failed to fetch context stats:', err);
    }
  }, [draft.draft_id]);

  useEffect(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    
    debounceTimerRef.current = setTimeout(() => {
      fetchStats(CONTEXT_LEVELS[levelIndex]);
    }, 500);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [levelIndex, fetchStats]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    setError(null);
    
    try {
      const processedFile = await resizeImage(file);
      const attachment = await uploadAttachment(draft.draft_id, processedFile);
      setFiles([...files, attachment]);
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
      setFiles(files.filter(f => f.id !== attachmentId));
    } catch (err) {
      setError((err as Error).message || 'Failed to remove file');
    }
  };

  const handleGenerate = async () => {
    setIsGenerating(true);
    setError(null);
    setGenerationTrace(undefined);
    
    const generatePromise = generatePlan(draft.draft_id);
    
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
      setFiles([...files, attachment]);
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

  return (
    <div className="max-w-4xl mx-auto p-6 bg-white rounded-lg shadow">
      <h2 className="text-2xl font-bold text-gray-900 mb-2">Configure AI Planner</h2>
      <p className="text-gray-600 mb-6">
        Repository: <span className="font-mono text-gray-900">{draft.repository}</span>
      </p>
      <div className="bg-gray-50 rounded-md p-4 mb-6">
        <p className="text-gray-700 italic">"{draft.prompt}"</p>
      </div>

      <div className="mb-8">
        <label className="block text-sm font-medium text-gray-700 mb-2">Context Sensitivity</label>
        <input 
          type="range" 
          min="0" 
          max="2" 
          step="1"
          value={levelIndex}
          onChange={(e) => setLevelIndex(parseInt(e.target.value))}
          className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-indigo-600"
        />
        <div className="flex justify-between text-xs text-gray-500 mt-2">
          {CONTEXT_LABELS.map((label, idx) => (
            <span 
              key={label} 
              className={idx === levelIndex ? 'text-indigo-600 font-medium' : ''}
            >
              {label}
            </span>
          ))}
        </div>
        
        {stats && (
          <div className={`mt-4 p-4 rounded-md border flex items-center justify-between ${getCostColorClass(stats.costEstimate)}`}>
            <div className="flex items-center gap-4">
              <span className="font-bold">Est. Cost: ${stats.costEstimate.toFixed(3)}</span>
              <span>({stats.tokenCount.toLocaleString()} tokens)</span>
            </div>
            {stats.smartFiles > 0 && (
              <span className="text-sm bg-indigo-100 text-indigo-700 px-3 py-1 rounded-full">
                Auto-selected {stats.smartFiles} relevant files
              </span>
            )}
          </div>
        )}
      </div>

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
        {files.length > 0 && (
          <ul className="mt-4 space-y-2">
            {files.map(f => (
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
        disabled={isGenerating}
        className={`w-full py-3 rounded-lg font-medium transition-colors ${
          isGenerating
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
        ) : (
          'Generate Implementation Plan'
        )}
      </button>
    </div>
  );
};

export default SetupWizard;
