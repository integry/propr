import { useState, useCallback, useRef, useEffect } from 'react';
import { debounce } from 'lodash';
import { updateDraft, refinePlan, getDraftWithPlan, PlanTask } from '../api/gitfixApi';

export type SaveStatus = 'saved' | 'saving' | 'error';

export interface DeletedTask {
  task: PlanTask;
  index: number;
}

interface UsePlanRefinementResult {
  plan: PlanTask[];
  updatePlan: (newPlan: PlanTask[], origin?: 'user' | 'ai') => void;
  updateTask: (taskId: string, updates: Partial<PlanTask>) => void;
  addTask: (afterTaskId: string) => void;
  deleteTask: (taskId: string) => DeletedTask | null;
  restoreTask: (deleted: DeletedTask) => void;
  reorderTasks: (activeId: string, overId: string) => void;
  handleRefine: (instruction: string) => Promise<{ success: boolean; message: string }>;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  saveStatus: SaveStatus;
  highlightedIds: string[];
}

export const usePlanRefinement = (draftId: string, initialPlan: PlanTask[]): UsePlanRefinementResult => {
  const [history, setHistory] = useState<PlanTask[][]>([initialPlan]);
  const [pointer, setPointer] = useState(0);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const [highlightedIds, setHighlightedIds] = useState<string[]>([]);
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
    if (origin === 'ai') {
      const changed: string[] = [];
      newPlan.forEach((task, i) => {
        const oldTask = currentPlan[i];
        if (!oldTask || JSON.stringify(task) !== JSON.stringify(oldTask)) {
          changed.push(task.id);
        }
      });
      if (newPlan.length !== currentPlan.length) {
        newPlan.slice(currentPlan.length).forEach(t => changed.push(t.id));
      }
      setHighlightedIds(changed);
      setTimeout(() => setHighlightedIds([]), 2000);
    }

    const newHistory = history.slice(0, pointer + 1);
    newHistory.push(newPlan);
    setHistory(newHistory);
    setPointer(newHistory.length - 1);
    saveToServer(newPlan);
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
    const index = currentPlan.findIndex(t => t.id === taskId);
    if (index === -1) return null;

    const task = currentPlan[index];
    const newPlan = currentPlan.filter(t => t.id !== taskId);
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

  const handleRefine = useCallback(async (instruction: string): Promise<{ success: boolean; message: string }> => {
    try {
      // Start refinement - returns immediately with 202
      await refinePlan(draftId, currentPlan, instruction);

      // Poll for completion
      const pollForCompletion = async (): Promise<{ success: boolean; message: string }> => {
        const maxAttempts = 300; // 5 minutes max
        for (let i = 0; i < maxAttempts; i++) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          const draft = await getDraftWithPlan(draftId);

          if (draft.status === 'review') {
            // Refinement complete - defensively parse plan_json if it's a string
            let planJson = draft.plan_json;
            if (typeof planJson === 'string') {
              try { planJson = JSON.parse(planJson); } catch { planJson = []; }
            }
            if (planJson && Array.isArray(planJson)) {
              updatePlan(planJson, 'ai');
              return { success: true, message: 'Plan refined successfully' };
            }
            return { success: false, message: 'Refinement completed but no plan returned' };
          }

          if (draft.status !== 'refining') {
            // Unexpected status
            return { success: false, message: 'Refinement failed unexpectedly' };
          }
        }
        return { success: false, message: 'Refinement timed out. Please try again.' };
      };

      return await pollForCompletion();
    } catch (e) {
      console.error(e);
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
    highlightedIds
  };
};
