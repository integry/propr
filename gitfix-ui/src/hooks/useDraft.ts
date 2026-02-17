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

  // Track whether we've used initial data for this specific draftId
  const initialDataUsedForDraftIdRef = useRef<string | null>(null);

  // Determine if we should use initial data:
  // - initialData must be provided
  // - initialData's draft_id must match the current draftId
  // - we haven't already used initial data for this draftId
  const shouldUseInitialData =
    initialData &&
    initialData.draft_id === draftId &&
    initialDataUsedForDraftIdRef.current !== draftId;

  const [draft, setDraft] = useState<PlannerDraft | null>(
    shouldUseInitialData ? initialData : null
  );
  const [loading, setLoading] = useState<boolean>(!shouldUseInitialData);
  const [error, setError] = useState<string | null>(null);

  // Mark initial data as used for this draftId
  if (shouldUseInitialData) {
    initialDataUsedForDraftIdRef.current = draftId;
  }

  const fetchDraft = useCallback(async (isPolling = false) => {
    if (!draftId) return;

    try {
      // Only show loading state on initial fetch, not during polling
      if (!isPolling) {
        setLoading(true);
      }
      setError(null);
      const data = await getDraft(draftId);
      // Defensively parse JSON fields in case backend returns strings
      setDraft(parseJsonFields(data as unknown as Record<string, unknown>) as unknown as PlannerDraft);
    } catch (err) {
      setError((err as Error).message || 'Failed to fetch draft');
    } finally {
      if (!isPolling) {
        setLoading(false);
      }
    }
  }, [draftId]);

  useEffect(() => {
    // Skip initial fetch if we have valid initial data for this draftId
    if (initialData && initialData.draft_id === draftId && initialDataUsedForDraftIdRef.current === draftId) {
      // We already have the data, no need to fetch
      return;
    }
    fetchDraft();
  }, [fetchDraft, draftId, initialData]);

  useEffect(() => {
    if (draft?.status !== 'generating') return;

    const interval = setInterval(() => fetchDraft(true), 3000);
    return () => clearInterval(interval);
  }, [draft?.status, fetchDraft]);

  return { draft, loading, error, refetch: () => fetchDraft(false) };
};
