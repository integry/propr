import { useState, useEffect, useCallback, useRef } from 'react';
import { getDraft, PlannerDraft } from '../api/proprApi';
import { useSocket } from '../contexts/useSocket';
import { DraftUpdatePayload } from '@propr/shared';

interface UseDraftOptions {
  initialData?: PlannerDraft | null;
}

interface UseDraftResult {
  draft: PlannerDraft | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

// Helper to safely parse JSON string fields that should be arrays/objects
function parseJsonFields<T extends Record<string, unknown>>(data: T): T {
  const result = { ...data };
  const jsonFields = ['plan_json', 'chat_history', 'attachments'] as const;
  for (const field of jsonFields) {
    if (typeof result[field] === 'string') {
      try { result[field] = JSON.parse(result[field] as string); } catch { result[field] = []; }
    }
  }
  if (typeof result.context_config === 'string') {
    try { result.context_config = JSON.parse(result.context_config as string); } catch { result.context_config = {}; }
  }
  if (typeof result.generation_trace === 'string') {
    try { result.generation_trace = JSON.parse(result.generation_trace as string); } catch { result.generation_trace = null; }
  }
  return result;
}

export const useDraft = (draftId: string, options: UseDraftOptions = {}): UseDraftResult => {
  const { initialData } = options;
  const { subscribeToDraft, unsubscribeFromDraft, onDraftUpdate, isConnected } = useSocket();

  // Check if initialData is valid for this draftId
  const hasValidInitialData = Boolean(initialData && initialData.draft_id === draftId);

  // Track whether we've already consumed the initial data for this draftId
  // This prevents re-using stale initial data on subsequent renders
  const consumedInitialDataRef = useRef<string | null>(null);
  const isInitialDataConsumed = consumedInitialDataRef.current === draftId;

  // Use initial data if it's valid and hasn't been consumed yet
  const useInitialData = hasValidInitialData && !isInitialDataConsumed;

  // Initialize state - only use initialData on first mount when valid
  const [draft, setDraft] = useState<PlannerDraft | null>(() => {
    if (useInitialData) {
      consumedInitialDataRef.current = draftId;
      return initialData;
    }
    return null;
  });
  const [loading, setLoading] = useState<boolean>(() => !useInitialData);
  const [error, setError] = useState<string | null>(null);

  // Fetch function - only sets loading for explicit refetch, not background refresh
  const fetchDraft = useCallback(async (showLoading = true) => {
    if (!draftId) return;

    try {
      if (showLoading) {
        setLoading(true);
      }
      setError(null);
      const data = await getDraft(draftId);
      setDraft(parseJsonFields(data as unknown as Record<string, unknown>) as unknown as PlannerDraft);
    } catch (err) {
      setError((err as Error).message || 'Failed to fetch draft');
    } finally {
      if (showLoading) {
        setLoading(false);
      }
    }
  }, [draftId]);

  // Initial fetch effect - handles both initial load and draftId changes
  useEffect(() => {
    // If we already have draft data (from initialData), skip the fetch
    // The draft state was set during initialization
    if (draft && draft.draft_id === draftId) {
      return;
    }
    // When draftId changes to a different value, reset state and fetch new data
    // This handles navigation between saved plans (e.g., /studio/abc to /studio/xyz)
    // and also when navigating to /studio/new (where draftId becomes empty/undefined)
    if (draft && draft.draft_id !== draftId) {
      setDraft(null);
      setError(null);
    }
    // Fetch if we have a valid draftId and either don't have data or draftId changed
    if (draftId && (!draft || draft.draft_id !== draftId)) {
      fetchDraft(true);
    }
  }, [draftId]); // eslint-disable-line react-hooks/exhaustive-deps

  const applySocketSnapshot = useCallback((payload: DraftUpdatePayload) => {
    setDraft(currentDraft => {
      if (!currentDraft || currentDraft.draft_id !== payload.draftId) {
        return currentDraft;
      }

      return parseJsonFields({
        ...currentDraft,
        status: payload.draftStatus ?? currentDraft.status,
        generation_trace: payload.generationTrace ?? currentDraft.generation_trace,
      } as unknown as Record<string, unknown>) as unknown as PlannerDraft;
    });
  }, []);

  // Handle draft update from WebSocket
  const handleDraftUpdate = useCallback(async (payload: DraftUpdatePayload) => {
    if (payload.draftId !== draftId) return;

    console.log('[useDraft] Received draft update via WebSocket:', payload);
    applySocketSnapshot(payload);

    // Progress updates are self-sufficient in the socket payload; only resync when the
    // draft leaves generation and the UI needs the full server representation.
    if (payload.draftStatus && payload.draftStatus !== 'generating') {
      await fetchDraft(false);
    }
  }, [draftId, applySocketSnapshot, fetchDraft]);

  // Subscribe to WebSocket events for this draft when generating
  useEffect(() => {
    if (!draftId || !isConnected) return;
    // Only subscribe when draft is generating
    if (draft?.status !== 'generating') return;

    // Subscribe to this specific draft's room
    subscribeToDraft(draftId);

    // Listen for draft updates
    const unsubscribe = onDraftUpdate(handleDraftUpdate);

    return () => {
      unsubscribeFromDraft(draftId);
      unsubscribe();
    };
  }, [draftId, draft?.status, isConnected, subscribeToDraft, unsubscribeFromDraft, onDraftUpdate, handleDraftUpdate]);

  return { draft, loading, error, refetch: () => fetchDraft(true) };
};
