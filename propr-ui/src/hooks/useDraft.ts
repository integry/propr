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
  activateGenerationRun: (runId: string, draftId: string, snapshot?: PlannerDraft) => void;
}

function ensureArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// Helper to safely parse JSON string fields that should be arrays/objects
function parseJsonFields(data: Record<string, unknown>): Record<string, unknown> {
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
  result.plan_json = ensureArray(result.plan_json);
  result.chat_history = ensureArray(result.chat_history);
  result.attachments = ensureArray(result.attachments);
  return result;
}

function mergeGenerationTrace(
  currentTrace: PlannerDraft['generation_trace'],
  incomingTrace: DraftUpdatePayload['generationTrace']
): PlannerDraft['generation_trace'] {
  if (!incomingTrace) {
    return currentTrace;
  }

  const currentSteps = new Map((currentTrace?.steps ?? []).map((step) => [step.name, step]));
  return {
    ...currentTrace,
    ...incomingTrace,
    steps: incomingTrace.steps.map((step) => {
      const currentStep = currentSteps.get(step.name);
      const mergedData = step.data
        ? { ...currentStep?.data, ...step.data }
        : currentStep?.data;

      return {
        ...currentStep,
        ...step,
        ...(mergedData ? { data: mergedData } : {})
      };
    })
  };
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
      return initialData ?? null;
    }
    return null;
  });
  const [loading, setLoading] = useState<boolean>(() => !useInitialData);
  const [error, setError] = useState<string | null>(null);
  const activeRunIdRef = useRef(draft?.generation_trace?.runId);
  activeRunIdRef.current = draft?.generation_trace?.runId;
  // Callers may hold an activation callback from a render before an in-place draft id arrived.
  const draftIdRef = useRef(draftId);
  draftIdRef.current = draftId;
  // Bumped when a run is acknowledged locally; a fetch requested before that can only return
  // the pre-generation snapshot and must not replace the acknowledged run.
  const activationSeqRef = useRef(0);

  // Each read is owned by the selection that requested it: changing draftId or unmounting
  // invalidates every read in flight, and a newer read for the same draft supersedes an older one,
  // so a late completion cannot alter a newer selection even when the draft ID matches again.
  const fetchSeqRef = useRef(0);

  // Fetch function - only sets loading for explicit refetch, not background refresh
  const fetchDraft = useCallback(async (showLoading = true) => {
    if (!draftId || draftId !== draftIdRef.current) return;

    const activationSeq = activationSeqRef.current;
    const isSuperseded = () => activationSeq !== activationSeqRef.current;
    const fetchSeq = ++fetchSeqRef.current;
    const isCurrent = () => fetchSeq === fetchSeqRef.current && draftIdRef.current === draftId;
    try {
      if (showLoading) {
        setLoading(true);
      }
      setError(null);
      const data = await getDraft(draftId);
      if (!isCurrent() || isSuperseded()) return;
      const parsedDraft = parseJsonFields(data as unknown as Record<string, unknown>) as unknown as PlannerDraft;
      activeRunIdRef.current = parsedDraft.generation_trace?.runId;
      setDraft(parsedDraft);
    } catch (err) {
      if (isCurrent() && !isSuperseded()) setError((err as Error).message || 'Failed to fetch draft');
    } finally {
      // The latest read ends loading for its selection, including a loading read it superseded;
      // a read abandoned for /studio/new (no selection) still ends its own loading state.
      if (isCurrent() || (showLoading && !draftIdRef.current)) {
        setLoading(false);
      }
    }
  }, [draftId]);

  useEffect(() => () => { fetchSeqRef.current += 1; }, [draftId]);

  // Initial fetch effect - handles both initial load and draftId changes
  useEffect(() => {
    // If we already have draft data (from initialData), skip the loading fetch
    // The draft state was set during initialization
    if (draft && draft.draft_id === draftId) {
      // A generating snapshot from router state is stale when the entry is revisited via
      // back/forward or reload; resync once so a finished run is not shown as in progress.
      if (draft.status === 'generating') void fetchDraft(false);
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
      const activeRunId = currentDraft.generation_trace?.runId;
      if (activeRunId && payload.runId !== activeRunId) {
        return currentDraft;
      }

      return parseJsonFields({
        ...currentDraft,
        status: payload.draftStatus ?? currentDraft.status,
        generation_trace: mergeGenerationTrace(currentDraft.generation_trace, payload.generationTrace),
      } as unknown as Record<string, unknown>) as unknown as PlannerDraft;
    });
  }, []);

  // draftId names the draft the run was started for; a delayed acknowledgement for another draft
  // is ignored. The snapshot stands in for the draft while its first fetch is still in flight.
  const activateGenerationRun = useCallback((runId: string, runDraftId: string, snapshot?: PlannerDraft) => {
    const currentDraftId = draftIdRef.current;
    if (!currentDraftId || runDraftId !== currentDraftId) return;
    if (snapshot && snapshot.draft_id !== currentDraftId) return;
    activeRunIdRef.current = runId;
    if (snapshot) activationSeqRef.current += 1;
    setDraft(currentDraft => {
      const base = currentDraft?.draft_id === currentDraftId ? currentDraft : snapshot;
      if (!base) return currentDraft;
      return {
        ...base,
        status: 'generating',
        generation_trace: { steps: [], runId },
      };
    });
    if (snapshot) {
      setError(null);
      setLoading(false);
    }
  }, []);

  // Handle draft update from WebSocket
  const handleDraftUpdate = useCallback(async (payload: DraftUpdatePayload) => {
    if (payload.draftId !== draftId) return;
    const activeRunId = activeRunIdRef.current;
    if (activeRunId && payload.runId !== activeRunId) return;

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

  return { draft, loading, error, refetch: () => fetchDraft(true), activateGenerationRun };
};
