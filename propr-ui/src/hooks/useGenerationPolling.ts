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
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const { subscribeToDraft, unsubscribeFromDraft, onDraftUpdate, isConnected } = useSocket();

  const handleDraftUpdate = useCallback((payload: DraftUpdatePayload) => {
    if (payload.draftId !== draftId || !isGeneratingRef.current) return;

    // Use the trace snapshot from the payload when available
    if (payload.generationTrace) {
      setGenerationTrace(payload.generationTrace as GenerationTrace);
      if (payload.generationTrace.error) {
        setGenerationError(payload.generationTrace.error);
        setIsGenerating(false);
        isGeneratingRef.current = false;
        return;
      }
    }

    // React to terminal draft statuses carried in the payload
    if (payload.draftStatus === 'review') {
      setIsGenerating(false);
      isGeneratingRef.current = false;
      onCompleteRef.current();
      return;
    }

    if (payload.draftStatus === 'failed') {
      setGenerationError(payload.generationTrace?.error || 'Plan generation failed');
      setIsGenerating(false);
      isGeneratingRef.current = false;
      return;
    }
  }, [draftId]);

  // Subscribe to WebSocket events when generating
  useEffect(() => {
    if (!draftId || !isConnected || !isGenerating) return;

    subscribeToDraft(draftId);
    const unsubscribe = onDraftUpdate(handleDraftUpdate);

    return () => {
      unsubscribeFromDraft(draftId);
      unsubscribe();
    };
  }, [draftId, isConnected, isGenerating, subscribeToDraft, unsubscribeFromDraft, onDraftUpdate, handleDraftUpdate]);

  // Shared poll function — used as HTTP fallback and safety-net resync
  const pollDraft = useCallback(async () => {
    if (!isGeneratingRef.current || !draftId) return;

    try {
      const updatedDraft = await getDraft(draftId);

      if (updatedDraft.generation_trace) {
        setGenerationTrace(updatedDraft.generation_trace);
        const trace = updatedDraft.generation_trace as GenerationTrace & { error?: string };
        if (trace.error) {
          setGenerationError(trace.error);
          setIsGenerating(false);
          isGeneratingRef.current = false;
          return;
        }
      }

      if (updatedDraft.status === 'review') {
        setIsGenerating(false);
        isGeneratingRef.current = false;
        onCompleteRef.current();
      }

      if (updatedDraft.status === 'failed') {
        const trace = updatedDraft.generation_trace as GenerationTrace & { error?: string };
        setGenerationError(trace?.error || 'Plan generation failed');
        setIsGenerating(false);
        isGeneratingRef.current = false;
      }
    } catch (e) {
      console.error('[useGenerationPolling] Poll error:', e);
    }
  }, [draftId]);

  // HTTP fallback polling — active when WebSocket is NOT connected
  useEffect(() => {
    if (!draftId || !isGenerating || isConnected) return;

    const initialPollTimeout = setTimeout(pollDraft, 1000);
    const intervalId = setInterval(pollDraft, 3000);

    return () => {
      clearTimeout(initialPollTimeout);
      clearInterval(intervalId);
    };
  }, [draftId, isGenerating, isConnected, pollDraft]);

  // Resync on socket reconnection to catch any events missed during the gap
  const wasConnectedRef = useRef(true);
  useEffect(() => {
    if (!draftId || !isGenerating) return;

    if (isConnected && !wasConnectedRef.current) {
      pollDraft();
    }
    wasConnectedRef.current = isConnected;
  }, [draftId, isGenerating, isConnected, pollDraft]);

  const stopPolling = useCallback(() => {
    setIsGenerating(false);
    isGeneratingRef.current = false;
  }, []);

  const startPolling = useCallback(() => {
    setIsGenerating(true);
    isGeneratingRef.current = true;
    setGenerationTrace({
      steps: [
        { name: 'relevance', status: 'in_progress' },
        { name: 'context', status: 'pending' },
        { name: 'llm', status: 'pending' }
      ]
    });
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
