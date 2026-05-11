import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { debounce } from 'lodash';
import {
  uploadAttachment,
  createDraft as apiCreateDraft,
  updateDraft,
  PlannerDraft,
  DraftWithPlan,
  DraftContextConfig
} from '../../api/proprApi';

export type DraftSetupSnapshot = Pick<
  DraftContextConfig,
  'baseBranch' | 'granularity' | 'contextLevel' | 'compress' | 'contextRepositories' | 'generationModel' | 'manualFiles' | 'excludedFiles'
>;

function getDraftSetupSnapshot(baseBranch?: string, setupSnapshot?: DraftSetupSnapshot): DraftSetupSnapshot | undefined {
  if (!baseBranch && !setupSnapshot) {
    return undefined;
  }

  return {
    ...setupSnapshot,
    ...(baseBranch ? { baseBranch } : {})
  };
}

// Helper to construct a DraftWithPlan from a PlannerDraft for router state
export function constructDraftWithPlan(draft: PlannerDraft, setupSnapshot?: DraftSetupSnapshot): DraftWithPlan {
  return {
    ...draft,
    plan_json: [],
    chat_history: [],
    context_config: setupSnapshot ? { ...draft.context_config, ...setupSnapshot } : draft.context_config,
    refinement_result: undefined
  };
}

export function attachResolvedBaseBranch<T extends PlannerDraft>(draft: T, setupSnapshot?: DraftSetupSnapshot): T & { context_config?: DraftContextConfig } {
  if (!setupSnapshot) {
    return draft;
  }

  return {
    ...draft,
    context_config: { ...draft.context_config, ...setupSnapshot }
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

export function getBaseBranchPersistenceWarning(baseBranch?: string): string | null {
  if (!baseBranch) {
    return null;
  }

  return `Draft created, but failed to save base branch "${baseBranch}". Reloading may require fetching the default branch again.`;
}

// Debounce delay before auto-creating draft after user starts typing
const AUTO_DRAFT_DEBOUNCE_DELAY = 1000;

// Hook: Auto-create draft when user starts typing in new mode
interface AutoDraftCreationParams {
  isNewMode: boolean;
  selectedRepo: string;
  resolvedBaseBranch: string;
  setupSnapshot?: DraftSetupSnapshot;
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
  setupSnapshot,
  prompt,
  localFiles,
  onDraftCreated,
  onDraftCreatedInPlace,
  navigate,
  todoIds
}: AutoDraftCreationParams) {
  const [isAutoCreating, setIsAutoCreating] = useState(false);
  const [autoCreateError, setAutoCreateError] = useState<string | null>(null);
  const [autoCreateWarning, setAutoCreateWarning] = useState<string | null>(null);
  const draftCreatedRef = useRef(false);
  const lastSelectionKeyRef = useRef(`${selectedRepo}:${resolvedBaseBranch}`);

  // Reset when the selected repository entry changes, including duplicate owner/repo entries on another branch.
  useEffect(() => {
    const selectionKey = `${selectedRepo}:${resolvedBaseBranch}`;
    if (selectionKey !== lastSelectionKeyRef.current) {
      draftCreatedRef.current = false;
      lastSelectionKeyRef.current = selectionKey;
    }
  }, [selectedRepo, resolvedBaseBranch]);

  // Create draft function
  const createDraftNow = useCallback(async (repo: string, currentPrompt: string) => {
    if (!repo || !currentPrompt.trim() || draftCreatedRef.current) return;

    setIsAutoCreating(true);
    setAutoCreateError(null);
    setAutoCreateWarning(null);

    try {
      const newDraft = await apiCreateDraft(repo, currentPrompt.trim(), { todoIds });
      let baseBranchPersistenceWarning: string | null = null;

      try {
        await persistResolvedBaseBranch(newDraft.draft_id, resolvedBaseBranch);
      } catch (err) {
        console.error('Failed to persist resolved base branch:', err);
        baseBranchPersistenceWarning = getBaseBranchPersistenceWarning(resolvedBaseBranch);
        if (onDraftCreatedInPlace) {
          setAutoCreateWarning(baseBranchPersistenceWarning);
        }
      }

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
      const hydratedSetupSnapshot = getDraftSetupSnapshot(resolvedBaseBranch, setupSnapshot);
      const draftWithResolvedBranch = attachResolvedBaseBranch(newDraft, hydratedSetupSnapshot);
      if (onDraftCreatedInPlace) {
        onDraftCreatedInPlace(draftWithResolvedBranch);
        setIsAutoCreating(false);
      } else {
        setIsAutoCreating(false);
        const draftWithPlan = constructDraftWithPlan(newDraft, hydratedSetupSnapshot);
        navigate(`/studio/${newDraft.draft_id}`, {
          replace: true,
          state: {
            initialDraft: draftWithPlan,
            initialBaseBranch: resolvedBaseBranch,
            baseBranchPersistenceWarning
          }
        });
      }
    } catch (err) {
      setAutoCreateError((err as Error).message || 'Failed to auto-save draft');
      setIsAutoCreating(false);
    }
  }, [localFiles, onDraftCreated, onDraftCreatedInPlace, navigate, resolvedBaseBranch, setupSnapshot, todoIds]);

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
    if (!resolvedBaseBranch) return;

    const trimmedPrompt = prompt.trim();
    if (trimmedPrompt.length > 0) {
      debouncedCreateDraft(selectedRepo, prompt);
    }

    return () => {
      debouncedCreateDraft.cancel();
    };
  }, [isNewMode, selectedRepo, resolvedBaseBranch, prompt, debouncedCreateDraft]);

  return { isAutoCreating, autoCreateError, autoCreateWarning };
}
