import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { debounce } from 'lodash';
import {
  uploadAttachment,
  createDraft as apiCreateDraft,
  updateDraft,
  PlannerDraft,
  DraftWithPlan
} from '../../api/proprApi';

// Helper to construct a DraftWithPlan from a PlannerDraft for router state
export function constructDraftWithPlan(draft: PlannerDraft, baseBranch?: string): DraftWithPlan {
  return {
    ...draft,
    plan_json: [],
    chat_history: [],
    context_config: baseBranch ? { baseBranch } : undefined,
    refinement_result: undefined
  };
}

export function attachResolvedBaseBranch<T extends PlannerDraft>(draft: T, baseBranch?: string): T & { context_config?: { baseBranch?: string } } {
  if (!baseBranch) {
    return draft;
  }

  return {
    ...draft,
    context_config: { baseBranch }
  };
}

export async function persistResolvedBaseBranch(draftId: string, baseBranch?: string): Promise<void> {
  if (!baseBranch) {
    return;
  }

  await updateDraft(draftId, {
    context_config: { baseBranch }
  } as Parameters<typeof updateDraft>[1] & { context_config: { baseBranch: string } });
}

// Debounce delay before auto-creating draft after user starts typing
const AUTO_DRAFT_DEBOUNCE_DELAY = 1000;

// Hook: Auto-create draft when user starts typing in new mode
interface AutoDraftCreationParams {
  isNewMode: boolean;
  selectedRepo: string;
  resolvedBaseBranch: string;
  prompt: string;
  localFiles: File[];
  onDraftCreated?: (draftId: string) => void;
  // Called to update draft in-place without navigation (preserves focus)
  onDraftCreatedInPlace?: (draft: PlannerDraft) => void;
  navigate: (path: string, options?: { replace?: boolean; state?: unknown }) => void;
  /** Optional array of to-do IDs to link to the draft */
  todoIds?: string[];
}

export function useAutoDraftCreation({
  isNewMode,
  selectedRepo,
  resolvedBaseBranch,
  prompt,
  localFiles,
  onDraftCreated,
  onDraftCreatedInPlace,
  navigate,
  todoIds
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
      const newDraft = await apiCreateDraft(repo, currentPrompt.trim(), { todoIds });
      await persistResolvedBaseBranch(newDraft.draft_id, resolvedBaseBranch);
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
      // Use in-place update if callback provided (preserves focus, no navigation)
      // Otherwise fall back to navigation with router state
      const draftWithResolvedBranch = attachResolvedBaseBranch(newDraft, resolvedBaseBranch);
      if (onDraftCreatedInPlace) {
        onDraftCreatedInPlace(draftWithResolvedBranch);
      } else {
        const draftWithPlan = constructDraftWithPlan(newDraft, resolvedBaseBranch);
        navigate(`/studio/${newDraft.draft_id}`, {
          replace: true,
          state: { initialDraft: draftWithPlan, initialBaseBranch: resolvedBaseBranch }
        });
      }
    } catch (err) {
      setAutoCreateError((err as Error).message || 'Failed to auto-save draft');
      setIsAutoCreating(false);
    }
  }, [localFiles, onDraftCreated, onDraftCreatedInPlace, navigate, resolvedBaseBranch, todoIds]);

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
