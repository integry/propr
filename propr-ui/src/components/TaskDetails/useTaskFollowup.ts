import { useCallback } from 'react';
import { postTaskFollowup } from '../../api/proprApi';
import { useToast } from '../ui/useToast';
import { FollowupReceiptError } from './FollowupModal';
import { useFollowupHandoff } from './useFollowupHandoff';

/**
 * Posts the task header's follow-up. A receipt that is not a success is the
 * dialog's to explain; an accepted issue retry starts a separate run, which
 * this page hands off to while keeping its own failure as it was.
 */
export function useTaskFollowup(taskId: string | undefined) {
  const { addToast } = useToast();
  const { handoff, captureScope, accept, dismiss } = useFollowupHandoff(taskId);

  const submit = useCallback(async (body: string) => {
    if (!taskId) {
      throw new Error('Task ID is required');
    }
    const sentScope = captureScope();
    const result = await postTaskFollowup(taskId, body);
    if (!result.success) throw new FollowupReceiptError(result);
    const handedOff = accept(result, sentScope);
    addToast({
      type: 'success',
      message: handedOff ? 'Follow-up accepted. A new run is starting.' : result.state === 'batched' ? 'Follow-up added to the pending batch' : result.state === 'handled' ? 'Command handled successfully' : 'Follow-up queued successfully'
    });
  }, [taskId, addToast, captureScope, accept]);

  return { handoff, dismiss, submit };
}
