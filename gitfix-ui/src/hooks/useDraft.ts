import { useState, useEffect, useCallback } from 'react';
import { getDraft, PlannerDraft } from '../api/gitfixApi';

interface UseDraftResult {
  draft: PlannerDraft | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

export const useDraft = (draftId: string): UseDraftResult => {
  const [draft, setDraft] = useState<PlannerDraft | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const fetchDraft = useCallback(async () => {
    if (!draftId) return;
    
    try {
      setLoading(true);
      setError(null);
      const data = await getDraft(draftId);
      setDraft(data);
    } catch (err) {
      setError((err as Error).message || 'Failed to fetch draft');
    } finally {
      setLoading(false);
    }
  }, [draftId]);

  useEffect(() => {
    fetchDraft();
  }, [fetchDraft]);

  useEffect(() => {
    if (!draft || draft.status !== 'generating') return;

    const interval = setInterval(fetchDraft, 3000);
    return () => clearInterval(interval);
  }, [draft?.status, fetchDraft]);

  return { draft, loading, error, refetch: fetchDraft };
};
