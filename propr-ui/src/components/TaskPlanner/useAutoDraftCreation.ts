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
import { getDraftContextConfig } from './setupWizardDraftConfig';

export type DraftSetupSnapshot = Pick<
  DraftContextConfig,
  'baseBranch' | 'granularity' | 'contextLevel' | 'compress' | 'contextRepositories' | 'generationModel' | 'manualFiles' | 'excludedFiles'
>;

function mergeDraftSetupSnapshot(baseBranch?: string, setupSnapshot?: DraftSetupSnapshot): DraftSetupSnapshot | undefined {
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
    context_config: { ...(getDraftContextConfig(draft) ?? {}), ...setupSnapshot },
    refinement_result: undefined
  };
}

export function attachResolvedBaseBranch<T extends PlannerDraft>(draft: T, setupSnapshot?: DraftSetupSnapshot): T & { context_config?: DraftContextConfig } {
  return {
    ...draft,
    context_config: { ...(getDraftContextConfig(draft) ?? {}), ...setupSnapshot }
  };
}

export async function persistDraftSetupSnapshot(draftId: string, setupSnapshot?: DraftSetupSnapshot): Promise<void> {
  if (!setupSnapshot) {
    return;
  }

  await updateDraft(draftId, {
    context_config: setupSnapshot
  } as Parameters<typeof updateDraft>[1] & { context_config: DraftSetupSnapshot });
}

export async function persistResolvedBaseBranch(draftId: string, baseBranch?: string): Promise<void> {
  return persistDraftSetupSnapshot(draftId, mergeDraftSetupSnapshot(baseBranch));
}

export function getDraftSetupPersistenceWarning(baseBranch?: string): string | null {
  if (!baseBranch) {
    return null;
  }

  return `Draft created, but failed to save setup settings including base branch "${baseBranch}". Reloading may lose recent selections.`;
}

export const getBaseBranchPersistenceWarning = getDraftSetupPersistenceWarning;

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
  // In-flight creation promise, keyed by selection, so concurrent callers for the same selection share a single draft
  const creationPromiseRef = useRef<{ selectionKey: string; promise: Promise<PlannerDraft | null> } | null>(null);
  const createdDraftRef = useRef<PlannerDraft | null>(null);
  const lastSelectionKeyRef = useRef(`${selectedRepo}:${resolvedBaseBranch}`);

  // Reset when the selected repository entry changes, including duplicate owner/repo entries on another branch.
  useEffect(() => {
    const selectionKey = `${selectedRepo}:${resolvedBaseBranch}`;
    if (selectionKey !== lastSelectionKeyRef.current) {
      draftCreatedRef.current = false;
      createdDraftRef.current = null;
      lastSelectionKeyRef.current = selectionKey;
    }
  }, [selectedRepo, resolvedBaseBranch]);

  // Create draft function
  const createDraftNowInner = useCallback(async (repo: string, currentPrompt: string, selectionKey: string): Promise<PlannerDraft | null> => {
    if (!repo || !currentPrompt.trim() || draftCreatedRef.current) return null;
    // A creation started for a previous selection must not update state owned by the current selection
    const isCurrentSelection = () => lastSelectionKeyRef.current === selectionKey;
    const finishObsolete = () => {
      if (!creationPromiseRef.current || creationPromiseRef.current.selectionKey === selectionKey) {
        setIsAutoCreating(false);
      }
      return null;
    };

    setIsAutoCreating(true);
    setAutoCreateError(null);
    setAutoCreateWarning(null);

    try {
      const newDraft = await apiCreateDraft(repo, currentPrompt.trim(), { todoIds });
      let baseBranchPersistenceWarning: string | null = null;
      const hydratedSetupSnapshot = mergeDraftSetupSnapshot(resolvedBaseBranch, setupSnapshot);

      try {
        await persistDraftSetupSnapshot(newDraft.draft_id, hydratedSetupSnapshot);
      } catch (err) {
        console.error('Failed to persist draft setup snapshot:', err);
        baseBranchPersistenceWarning = getDraftSetupPersistenceWarning(resolvedBaseBranch);
        if (onDraftCreatedInPlace) {
          setAutoCreateWarning(baseBranchPersistenceWarning);
        }
      }

      if (!isCurrentSelection()) return finishObsolete();
      draftCreatedRef.current = true;

      // Upload any local files
      for (const file of localFiles) {
        try {
          await uploadAttachment(newDraft.draft_id, file);
        } catch (uploadErr) {
          console.error('Failed to upload attachment:', uploadErr);
        }
      }

      if (!isCurrentSelection()) return finishObsolete();
      if (onDraftCreated) onDraftCreated(newDraft.draft_id);
      // Use in-place update if callback provided (preserves focus, no navigation)
      // Otherwise fall back to navigation with router state
      const draftWithResolvedBranch = attachResolvedBaseBranch(newDraft, hydratedSetupSnapshot);
      createdDraftRef.current = draftWithResolvedBranch;
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
      return draftWithResolvedBranch;
    } catch (err) {
      if (!isCurrentSelection()) return finishObsolete();
      setAutoCreateError((err as Error).message || 'Failed to auto-save draft');
      setIsAutoCreating(false);
      return null;
    }
  }, [localFiles, onDraftCreated, onDraftCreatedInPlace, navigate, resolvedBaseBranch, setupSnapshot, todoIds]);

  const createDraftNow = useCallback((repo: string, currentPrompt: string): Promise<PlannerDraft | null> => {
    const selectionKey = `${repo}:${resolvedBaseBranch}`;
    if (creationPromiseRef.current?.selectionKey === selectionKey) return creationPromiseRef.current.promise;
    const promise = createDraftNowInner(repo, currentPrompt, selectionKey).finally(() => {
      if (creationPromiseRef.current?.promise === promise) creationPromiseRef.current = null;
    });
    creationPromiseRef.current = { selectionKey, promise };
    return promise;
  }, [createDraftNowInner, resolvedBaseBranch]);

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

  // Immediately create the draft (skipping the debounce) and return it.
  // Returns the already-created draft if one exists, or null if creation is not possible.
  const ensureDraftCreated = useCallback(async (): Promise<PlannerDraft | null> => {
    debouncedCreateDraft.cancel();
    if (creationPromiseRef.current?.selectionKey === `${selectedRepo}:${resolvedBaseBranch}`) return creationPromiseRef.current.promise;
    if (draftCreatedRef.current) return createdDraftRef.current;
    if (!isNewMode || !selectedRepo || !resolvedBaseBranch) return null;
    return createDraftNow(selectedRepo, prompt);
  }, [debouncedCreateDraft, createDraftNow, isNewMode, selectedRepo, resolvedBaseBranch, prompt]);

  return { isAutoCreating, autoCreateError, autoCreateWarning, ensureDraftCreated };
}
