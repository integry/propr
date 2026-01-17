import { useState, useRef, useEffect, useCallback } from 'react';
import { getDraft, GenerationTrace } from '../api/gitfixApi';

interface UseGenerationPollingOptions {
  draftId: string;
  onComplete: () => void;
}

interface UseGenerationPollingResult {
  isGenerating: boolean;
  generationTrace: GenerationTrace | undefined;
  generationError: string | null;
  startPolling: () => void;
  stopPolling: () => void;
  setGenerationError: (error: string | null) => void;
}

export function useGenerationPolling({
  draftId,
  onComplete,
}: UseGenerationPollingOptions): UseGenerationPollingResult {
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [generationTrace, setGenerationTrace] = useState<GenerationTrace | undefined>(undefined);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const pollingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    setIsGenerating(true);
    setGenerationTrace(undefined);
    setGenerationError(null);

    pollingIntervalRef.current = setInterval(async () => {
      try {
        const updatedDraft = await getDraft(draftId);
        if (updatedDraft.generation_trace) {
          setGenerationTrace(updatedDraft.generation_trace);
          // Check for error in generation trace
          const trace = updatedDraft.generation_trace as GenerationTrace & { error?: string };
          if (trace.error) {
            stopPolling();
            setGenerationError(trace.error);
            setIsGenerating(false);
            return;
          }
        }
        // Check if generation completed (status changed to 'review')
        if (updatedDraft.status === 'review') {
          stopPolling();
          onComplete();
        }
        // Check if generation failed (status went back to 'draft')
        if (updatedDraft.status === 'draft') {
          stopPolling();
          const trace = updatedDraft.generation_trace as GenerationTrace & { error?: string };
          setGenerationError(trace?.error || 'Plan generation failed');
          setIsGenerating(false);
        }
      } catch (e) {
        console.error('Failed to poll draft status:', e);
      }
    }, 1000);
  }, [draftId, onComplete, stopPolling]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopPolling();
    };
  }, [stopPolling]);

  return {
    isGenerating,
    generationTrace,
    generationError,
    startPolling,
    stopPolling,
    setGenerationError,
  };
}
