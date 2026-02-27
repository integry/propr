import { useState, useEffect, useCallback, useRef } from 'react';
import { getDraft, GenerationTrace } from '../api/proprApi';
import { useSocket } from '../contexts/useSocket';
import { DraftUpdatePayload } from '@propr/shared';

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
  const isGeneratingRef = useRef<boolean>(false);
  const { subscribeToDraft, unsubscribeFromDraft, onDraftUpdate, isConnected } = useSocket();

  // Handle draft update from WebSocket
  const handleDraftUpdate = useCallback(async (payload: DraftUpdatePayload) => {
    // Only process updates for the current draft when we're actively generating
    if (payload.draftId !== draftId || !isGeneratingRef.current) return;

    console.log('[useGenerationPolling] Received draft update via WebSocket:', payload);

    try {
      // Fetch the full draft to get the complete generation trace
      const updatedDraft = await getDraft(draftId);

      if (updatedDraft.generation_trace) {
        setGenerationTrace(updatedDraft.generation_trace);
        // Check for error in generation trace
        const trace = updatedDraft.generation_trace as GenerationTrace & { error?: string };
        if (trace.error) {
          setGenerationError(trace.error);
          setIsGenerating(false);
          isGeneratingRef.current = false;
          return;
        }
      }

      // Check if generation completed (status changed to 'review')
      if (updatedDraft.status === 'review') {
        setIsGenerating(false);
        isGeneratingRef.current = false;
        onComplete();
      }

      // Check if generation failed (status went back to 'draft')
      if (updatedDraft.status === 'draft' && payload.status === 'failed') {
        const trace = updatedDraft.generation_trace as GenerationTrace & { error?: string };
        setGenerationError(trace?.error || 'Plan generation failed');
        setIsGenerating(false);
        isGeneratingRef.current = false;
      }
    } catch (e) {
      console.error('Failed to fetch draft on update:', e);
    }
  }, [draftId, onComplete]);

  // Subscribe to WebSocket events when generating
  useEffect(() => {
    if (!draftId || !isConnected || !isGenerating) return;

    // Subscribe to this specific draft's room
    subscribeToDraft(draftId);

    // Listen for draft updates
    const unsubscribe = onDraftUpdate(handleDraftUpdate);

    return () => {
      unsubscribeFromDraft(draftId);
      unsubscribe();
    };
  }, [draftId, isConnected, isGenerating, subscribeToDraft, unsubscribeFromDraft, onDraftUpdate, handleDraftUpdate]);

  const stopPolling = useCallback(() => {
    setIsGenerating(false);
    isGeneratingRef.current = false;
  }, []);

  const startPolling = useCallback(() => {
    setIsGenerating(true);
    isGeneratingRef.current = true;
    setGenerationTrace(undefined);
    setGenerationError(null);
  }, []);

  return {
    isGenerating,
    generationTrace,
    generationError,
    startPolling,
    stopPolling,
    setGenerationError,
  };
}
