import { useCallback, useState } from 'react';
import { stopTaskExecution } from '../../api/proprApi';
import type { TaskRunEntry } from '../TaskList/rowModel';
import type { LiveRunControl } from './ActionBar';

/**
 * Stop for the task's newest run while the pane shows an earlier one. A stop
 * is a safety control, so it never waits for the operator to go back to the
 * run that is working. It reads as stopping until the newest run settles.
 */
export function useLiveRunStop(head: TaskRunEntry | undefined, active: boolean): LiveRunControl | undefined {
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  const headId = head?.task.id;

  const onStop = useCallback(async () => {
    if (!headId || !head) return;
    const confirmed = window.confirm(`Are you sure you want to stop Run ${head.number}? This action cannot be undone.`);
    if (!confirmed) return;
    setStoppingId(headId);
    try {
      await stopTaskExecution(headId);
    } catch (err) {
      console.error('Error stopping execution:', err);
      alert(`Failed to stop execution: ${(err as Error).message || 'Unknown error'}. The run may have already stopped.`);
      setStoppingId(null);
    }
  }, [head, headId]);

  if (!head || !active) return undefined;
  return { number: head.number, stopping: stoppingId === headId, onStop };
}
