import { useState, useCallback, useRef, useEffect } from 'react';
import { debounce } from 'lodash';
import { updateDraft, refinePlan, getDraftWithPlan, PlanTask, RefinementResult } from '../api/gitfixApi';

export type SaveStatus = 'saved' | 'saving' | 'error';

export interface DeletedTask {
  task: PlanTask;
  index: number;
}

/**
 * Ensures all tasks have unique, non-empty IDs.
 * - Generates IDs for tasks missing them
 * - Handles duplicate IDs by appending unique suffixes
 * - Ensures no empty or undefined IDs exist
 */
const ensureTaskIds = (tasks: PlanTask[]): PlanTask[] => {
  const seenIds = new Set<string>();
  let idCounter = 0;

  return tasks.map((task, index) => {
    // Generate a unique base ID using timestamp + index + counter
    const generateUniqueId = (): string => {
      const baseId = `task-${Date.now()}-${index}-${idCounter++}`;
      return baseId;
    };

    // Check if task has a valid ID
    const hasValidId = task.id && typeof task.id === 'string' && task.id.trim() !== '';

    let finalId: string;

    if (!hasValidId) {
      // Task is missing an ID, generate one
      finalId = generateUniqueId();
      console.warn(`[usePlanRefinement] Task at index ${index} missing ID, generated: ${finalId}`);
    } else if (seenIds.has(task.id)) {
      // Duplicate ID detected, generate a unique suffix
      const originalId = task.id;
      finalId = `${originalId}-dup-${idCounter++}`;
      console.warn(`[usePlanRefinement] Duplicate ID "${originalId}" at index ${index}, renamed to: ${finalId}`);
    } else {
      // ID is valid and unique
      finalId = task.id;
    }

    seenIds.add(finalId);

    // Return task with ensured ID (only create new object if ID changed)
    if (finalId !== task.id) {
      return { ...task, id: finalId };
    }
    return task;
  });
};

/**
 * Safely parses plan JSON, handling both string and array inputs.
 * Returns null if parsing fails or result is not a valid array.
 */
const parsePlanJson = (planJson: unknown): PlanTask[] | null => {
  let parsed = planJson;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return null; }
  }
  if (parsed && Array.isArray(parsed)) {
    return parsed as PlanTask[];
  }
  return null;
};

/**
 * Safely parses refinement result, handling both string and object inputs.
 */
const parseRefinementResult = (result: unknown): { summary?: string; action?: 'modified' | 'answered' | 'both' } | undefined => {
  if (typeof result === 'string') {
    try { return JSON.parse(result); } catch { return undefined; }
  }
  return result as { summary?: string; action?: 'modified' | 'answered' | 'both' } | undefined;
};

export interface RefinementProgress {
  /** Whether refinement is in progress */
  isRefining: boolean;
  /** ISO timestamp when refinement started */
  startedAt?: string;
  /** Estimated duration in milliseconds */
  estimatedDuration?: number;
  /** Whether the estimate is based on historical data */
  isHistoricalEstimate?: boolean;
}

interface UsePlanRefinementResult {
  plan: PlanTask[];
  updatePlan: (newPlan: PlanTask[], origin?: 'user' | 'ai') => void;
  updateTask: (taskId: string, updates: Partial<PlanTask>) => void;
  addTask: (afterTaskId: string) => void;
  deleteTask: (taskId: string) => DeletedTask | null;
  restoreTask: (deleted: DeletedTask) => void;
  reorderTasks: (activeId: string, overId: string) => void;
  handleRefine: (instruction: string) => Promise<{ success: boolean; message: string; action?: 'modified' | 'answered' | 'both' }>;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  saveStatus: SaveStatus;
  highlightedIds: string[];
  /** Progress data for refinement operations */
  refinementProgress: RefinementProgress;
}

export const usePlanRefinement = (draftId: string, initialPlan: PlanTask[]): UsePlanRefinementResult => {
  // Ensure initial plan has valid unique IDs
  const [history, setHistory] = useState<PlanTask[][]>(() => [ensureTaskIds(initialPlan)]);
  const [pointer, setPointer] = useState(0);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const [highlightedIds, setHighlightedIds] = useState<string[]>([]);
  const [refinementProgress, setRefinementProgress] = useState<RefinementProgress>({ isRefining: false });
  const saveRef = useRef<ReturnType<typeof debounce> | null>(null);

  const currentPlan = history[pointer];

  useEffect(() => {
    saveRef.current = debounce(async (plan: PlanTask[]) => {
      setSaveStatus('saving');
      try {
        await updateDraft(draftId, { plan_json: plan });
        setSaveStatus('saved');
      } catch {
        setSaveStatus('error');
      }
    }, 1000);

    return () => {
      saveRef.current?.cancel();
    };
  }, [draftId]);

  const saveToServer = useCallback((plan: PlanTask[]) => {
    saveRef.current?.(plan);
  }, []);

  const updatePlan = useCallback((newPlan: PlanTask[], origin: 'user' | 'ai' = 'user') => {
    // Ensure all tasks have valid unique IDs before updating
    const normalizedPlan = ensureTaskIds(newPlan);

    if (origin === 'ai') {
      const changed: string[] = [];
      normalizedPlan.forEach((task, i) => {
        const oldTask = currentPlan[i];
        if (!oldTask || JSON.stringify(task) !== JSON.stringify(oldTask)) {
          changed.push(task.id);
        }
      });
      if (normalizedPlan.length !== currentPlan.length) {
        normalizedPlan.slice(currentPlan.length).forEach(t => changed.push(t.id));
      }
      setHighlightedIds(changed);
      setTimeout(() => setHighlightedIds([]), 2000);
    }

    const newHistory = history.slice(0, pointer + 1);
    newHistory.push(normalizedPlan);
    setHistory(newHistory);
    setPointer(newHistory.length - 1);
    saveToServer(normalizedPlan);
  }, [history, pointer, currentPlan, saveToServer]);

  const updateTask = useCallback((taskId: string, updates: Partial<PlanTask>) => {
    const newPlan = currentPlan.map(task => 
      task.id === taskId ? { ...task, ...updates } : task
    );
    updatePlan(newPlan, 'user');
  }, [currentPlan, updatePlan]);

  const addTask = useCallback((afterTaskId: string) => {
    const index = currentPlan.findIndex(t => t.id === afterTaskId);
    const newTask: PlanTask = {
      id: `task-${Date.now()}`,
      title: 'New Task',
      body: '',
      implementation: ''
    };
    const newPlan = [...currentPlan];
    newPlan.splice(index + 1, 0, newTask);
    updatePlan(newPlan, 'user');
  }, [currentPlan, updatePlan]);

  const deleteTask = useCallback((taskId: string): DeletedTask | null => {
    // Validate that taskId is provided and non-empty
    if (!taskId || typeof taskId !== 'string' || taskId.trim() === '') {
      console.warn('[usePlanRefinement] deleteTask called with invalid taskId:', taskId);
      return null;
    }

    const index = currentPlan.findIndex(t => t.id === taskId);
    if (index === -1) {
      console.warn(`[usePlanRefinement] deleteTask: task with id "${taskId}" not found in plan`);
      return null;
    }

    const task = currentPlan[index];

    // Defensive check: ensure we're only removing one task
    const newPlan = currentPlan.filter(t => t.id !== taskId);

    // Safety check: verify we only removed one task
    if (newPlan.length !== currentPlan.length - 1) {
      console.error(`[usePlanRefinement] deleteTask: unexpected number of tasks removed. Expected to remove 1, but removed ${currentPlan.length - newPlan.length}`);
      // If something went wrong, don't modify the state
      if (newPlan.length < currentPlan.length - 1) {
        console.error('[usePlanRefinement] deleteTask: More than one task would be removed. Aborting delete operation.');
        return null;
      }
    }

    updatePlan(newPlan, 'user');

    return { task, index };
  }, [currentPlan, updatePlan]);

  const restoreTask = useCallback((deleted: DeletedTask) => {
    const newPlan = [...currentPlan];
    // Insert at the original index, or at the end if the index is out of bounds
    const insertIndex = Math.min(deleted.index, newPlan.length);
    newPlan.splice(insertIndex, 0, deleted.task);
    updatePlan(newPlan, 'user');
  }, [currentPlan, updatePlan]);

  const reorderTasks = useCallback((activeId: string, overId: string) => {
    const oldIndex = currentPlan.findIndex(t => t.id === activeId);
    const newIndex = currentPlan.findIndex(t => t.id === overId);

    if (oldIndex === -1 || newIndex === -1) return;

    const newPlan = [...currentPlan];
    const [removed] = newPlan.splice(oldIndex, 1);
    newPlan.splice(newIndex, 0, removed);

    updatePlan(newPlan, 'user');
  }, [currentPlan, updatePlan]);

  const handleRefine = useCallback(async (instruction: string): Promise<{ success: boolean; message: string; action?: 'modified' | 'answered' | 'both' }> => {
    try {
      // Set initial refining state
      setRefinementProgress({ isRefining: true });

      // Start refinement - returns immediately with 202
      await refinePlan(draftId, currentPlan, instruction);

      // Poll for completion
      const pollForCompletion = async (): Promise<{ success: boolean; message: string; action?: 'modified' | 'answered' | 'both' }> => {
        const maxAttempts = 300; // 5 minutes max
        let hasUpdatedProgress = false;

        for (let i = 0; i < maxAttempts; i++) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          const draft = await getDraftWithPlan(draftId);

          // Update progress from refinement_result if available
          if (!hasUpdatedProgress && draft.refinement_result) {
            const refinementResult = parseRefinementResult(draft.refinement_result) as RefinementResult | undefined;
            if (refinementResult?.startedAt && refinementResult?.estimatedDuration) {
              setRefinementProgress({
                isRefining: true,
                startedAt: refinementResult.startedAt,
                estimatedDuration: refinementResult.estimatedDuration,
                isHistoricalEstimate: refinementResult.isHistoricalEstimate
              });
              hasUpdatedProgress = true;
            }
          }

          if (draft.status === 'review') {
            // Refinement complete - defensively parse plan_json if it's a string
            const planJson = parsePlanJson(draft.plan_json);
            if (!planJson) {
              setRefinementProgress({ isRefining: false });
              return { success: false, message: 'Refinement completed but no plan returned' };
            }

            updatePlan(planJson, 'ai');

            // Extract refinement result with summary
            const refinementResult = parseRefinementResult(draft.refinement_result);
            const message = refinementResult?.summary || 'Plan processed successfully.';
            const action = refinementResult?.action;

            setRefinementProgress({ isRefining: false });
            return { success: true, message, action };
          }

          if (draft.status !== 'refining') {
            // Unexpected status
            setRefinementProgress({ isRefining: false });
            return { success: false, message: 'Refinement failed unexpectedly' };
          }
        }
        setRefinementProgress({ isRefining: false });
        return { success: false, message: 'Refinement timed out. Please try again.' };
      };

      return await pollForCompletion();
    } catch (e) {
      console.error(e);
      setRefinementProgress({ isRefining: false });
      return { success: false, message: 'Failed to refine plan. Please try again.' };
    }
  }, [draftId, currentPlan, updatePlan]);

  const undo = useCallback(() => {
    if (pointer > 0) {
      const prev = pointer - 1;
      setPointer(prev);
      saveToServer(history[prev]);
    }
  }, [pointer, history, saveToServer]);

  const redo = useCallback(() => {
    if (pointer < history.length - 1) {
      const next = pointer + 1;
      setPointer(next);
      saveToServer(history[next]);
    }
  }, [pointer, history, saveToServer]);

  return {
    plan: currentPlan,
    updatePlan,
    updateTask,
    addTask,
    deleteTask,
    restoreTask,
    reorderTasks,
    handleRefine,
    undo,
    redo,
    canUndo: pointer > 0,
    canRedo: pointer < history.length - 1,
    saveStatus,
    highlightedIds,
    refinementProgress
  };
};
