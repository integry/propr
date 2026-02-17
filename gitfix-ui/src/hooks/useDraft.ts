import { useState, useEffect, useCallback, useRef } from 'react';
import { getDraft, PlannerDraft } from '../api/gitfixApi';

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

  // Initial fetch effect - skip if we used initial data
  useEffect(() => {
    // If we already have draft data (from initialData), skip the fetch
    // The draft state was set during initialization
    if (draft && draft.draft_id === draftId) {
      return;
    }
    // Only fetch if we don't have data
    if (!draft) {
      fetchDraft(true);
    }
  }, [draftId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Polling effect for generating status
  useEffect(() => {
    if (draft?.status !== 'generating') return;

    const interval = setInterval(() => fetchDraft(false), 3000);
    return () => clearInterval(interval);
  }, [draft?.status, fetchDraft]);

  return { draft, loading, error, refetch: () => fetchDraft(true) };
};
