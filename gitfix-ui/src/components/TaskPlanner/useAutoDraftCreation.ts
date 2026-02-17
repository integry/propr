import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { debounce } from 'lodash';
import {
  uploadAttachment,
  createDraft as apiCreateDraft,
  PlannerDraft,
  DraftWithPlan
} from '../../api/gitfixApi';

// Helper to construct a DraftWithPlan from a PlannerDraft for router state
export function constructDraftWithPlan(draft: PlannerDraft): DraftWithPlan {
  return {
    ...draft,
    plan_json: [],
    chat_history: [],
    context_config: undefined,
    refinement_result: undefined
  };
}

// Debounce delay before auto-creating draft after user starts typing
const AUTO_DRAFT_DEBOUNCE_DELAY = 1000;

// Hook: Auto-create draft when user starts typing in new mode
interface AutoDraftCreationParams {
  isNewMode: boolean;
  selectedRepo: string;
  prompt: string;
  localFiles: File[];
  onDraftCreated?: (draftId: string) => void;
  navigate: (path: string, options?: { replace?: boolean; state?: unknown }) => void;
}

export function useAutoDraftCreation({
  isNewMode,
  selectedRepo,
  prompt,
  localFiles,
  onDraftCreated,
  navigate
}: AutoDraftCreationParams) {
  const [isAutoCreating, setIsAutoCreating] = useState(false);
  const [autoCreateError, setAutoCreateError] = useState<string | null>(null);
  const draftCreatedRef = useRef(false);
  const lastRepoRef = useRef(selectedRepo);

  // Reset when repo changes
  useEffect(() => {
    if (selectedRepo !== lastRepoRef.current) {
      draftCreatedRef.current = false;
      lastRepoRef.current = selectedRepo;
    }
  }, [selectedRepo]);

  // Create draft function
  const createDraftNow = useCallback(async (repo: string, currentPrompt: string) => {
    if (!repo || !currentPrompt.trim() || draftCreatedRef.current) return;

    setIsAutoCreating(true);
    setAutoCreateError(null);

    try {
      const newDraft = await apiCreateDraft(repo, currentPrompt.trim());
      draftCreatedRef.current = true;

      // Upload any local files
      for (const file of localFiles) {
        try {
          await uploadAttachment(newDraft.draft_id, file);
        } catch (uploadErr) {
          console.error('Failed to upload attachment:', uploadErr);
        }
      }

      if (onDraftCreated) onDraftCreated(newDraft.draft_id);
      // Pass the draft data via router state to avoid re-fetch and UI flicker
      const draftWithPlan = constructDraftWithPlan(newDraft);
      navigate(`/studio/${newDraft.draft_id}`, { replace: true, state: { initialDraft: draftWithPlan } });
    } catch (err) {
      setAutoCreateError((err as Error).message || 'Failed to auto-save draft');
      setIsAutoCreating(false);
    }
  }, [localFiles, onDraftCreated, navigate]);

  // Debounced create draft
  const debouncedCreateDraft = useMemo(
    () => debounce((repo: string, currentPrompt: string) => {
      createDraftNow(repo, currentPrompt);
    }, AUTO_DRAFT_DEBOUNCE_DELAY),
    [createDraftNow]
  );

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      debouncedCreateDraft.cancel();
    };
  }, [debouncedCreateDraft]);

  // Trigger auto-create when conditions are met
  useEffect(() => {
    if (!isNewMode || draftCreatedRef.current || !selectedRepo) return;

    const trimmedPrompt = prompt.trim();
    if (trimmedPrompt.length > 0) {
      debouncedCreateDraft(selectedRepo, prompt);
    }

    return () => {
      debouncedCreateDraft.cancel();
    };
  }, [isNewMode, selectedRepo, prompt, debouncedCreateDraft]);

  return { isAutoCreating, autoCreateError };
}
