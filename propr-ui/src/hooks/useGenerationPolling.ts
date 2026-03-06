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
  // Use a ref for onComplete to avoid re-creating callbacks when it changes
  // This prevents unnecessary re-subscriptions to WebSocket events
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const { subscribeToDraft, unsubscribeFromDraft, onDraftUpdate, isConnected } = useSocket();

  // Handle draft update from WebSocket
  const handleDraftUpdate = useCallback(async (payload: DraftUpdatePayload) => {
    // Only process updates for the current draft when we're actively generating
    if (payload.draftId !== draftId || !isGeneratingRef.current) return;

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
        onCompleteRef.current();
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
  }, [draftId]);

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

  // Shared poll function to fetch draft and update state
  const pollDraft = useCallback(async () => {
    if (!isGeneratingRef.current || !draftId) return;

    try {
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
        onCompleteRef.current();
      }

      // Check if generation failed (status went back to 'draft')
      if (updatedDraft.status === 'draft') {
        const trace = updatedDraft.generation_trace as GenerationTrace & { error?: string };
        if (trace?.error) {
          setGenerationError(trace.error);
          setIsGenerating(false);
          isGeneratingRef.current = false;
        }
      }
    } catch (e) {
      console.error('[useGenerationPolling] Poll error:', e);
    }
  }, [draftId]);

  // Primary fallback polling - active when WebSocket is NOT connected
  // Polls frequently (every 3 seconds) to ensure timely updates
  useEffect(() => {
    // Skip frequent polling if WebSocket is connected
    if (!draftId || !isGenerating || isConnected) return;

    // Initial poll after a short delay to let backend initialize
    const initialPollTimeout = setTimeout(pollDraft, 1000);

    // Set up polling interval (every 3 seconds as fallback)
    const intervalId = setInterval(pollDraft, 3000);

    return () => {
      clearTimeout(initialPollTimeout);
      clearInterval(intervalId);
    };
  }, [draftId, isGenerating, isConnected, pollDraft]);

  // Safety net polling - active even when WebSocket IS connected
  // Polls less frequently (every 10 seconds) to catch any missed WebSocket events
  // This ensures updates are not lost if WebSocket event publishing fails on the backend
  useEffect(() => {
    // Only run safety net when WebSocket is connected - otherwise primary polling handles it
    if (!draftId || !isGenerating || !isConnected) return;

    // Set up infrequent safety polling (every 10 seconds)
    const intervalId = setInterval(pollDraft, 10000);

    return () => {
      clearInterval(intervalId);
    };
  }, [draftId, isGenerating, isConnected, pollDraft]);

  const stopPolling = useCallback(() => {
    setIsGenerating(false);
    isGeneratingRef.current = false;
  }, []);

  const startPolling = useCallback(() => {
    setIsGenerating(true);
    isGeneratingRef.current = true;
    // Initialize with pending steps immediately to show progress UI without flicker
    // This ensures consistent UI from the start while waiting for backend updates
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
