import { useState, useCallback, useRef, useEffect } from 'react';
import { debounce } from 'lodash';
import { updateDraft, refinePlan, PlanTask } from '../api/gitfixApi';

export type SaveStatus = 'saved' | 'saving' | 'error';

interface UsePlanRefinementResult {
  plan: PlanTask[];
  updatePlan: (newPlan: PlanTask[], origin?: 'user' | 'ai') => void;
  updateTask: (taskId: string, updates: Partial<PlanTask>) => void;
  addTask: (afterTaskId: string) => void;
  deleteTask: (taskId: string) => void;
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
      files: []
    };
    const newPlan = [...currentPlan];
    newPlan.splice(index + 1, 0, newTask);
    updatePlan(newPlan, 'user');
  }, [currentPlan, updatePlan]);

  const deleteTask = useCallback((taskId: string) => {
    const newPlan = currentPlan.filter(t => t.id !== taskId);
    updatePlan(newPlan, 'user');
  }, [currentPlan, updatePlan]);

  const handleRefine = useCallback(async (instruction: string): Promise<{ success: boolean; message: string }> => {
    try {
      const response = await refinePlan(draftId, currentPlan, instruction);
      updatePlan(response.plan, 'ai');
      return { success: true, message: response.message };
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
    handleRefine,
    undo,
    redo,
    canUndo: pointer > 0,
    canRedo: pointer < history.length - 1,
    saveStatus,
    highlightedIds
  };
};
