import { useCallback, useEffect, useRef, useState } from 'react';
import { approveAgentRun, cancelAgentRun, getAgentRun, rejectAgentRun, type AgentRunRecord } from '../../api/agentDefinitionsApi';
import { useOptionalSocket } from '../../contexts/useSocket';
import { isTerminalRunState, rememberReportPreview } from './agentRunPresentation';

/** How often a run that has not finished is read again. */
export const AGENT_RUN_REFRESH_MS = 10_000;

export type AgentRunAction = 'approve' | 'reject' | 'cancel';

/**
 * One agent run, kept current while it is in progress: it is read again every
 * AGENT_RUN_REFRESH_MS and as soon as a socket update arrives for its report
 * or acting task, and no longer once it reaches a terminal state. A read is
 * applied only if nothing newer was recorded after it was sent, so a poll
 * answered after an approval cannot show the run as awaiting approval again.
 * Runs are fetched by their global ID, so a run that belongs to an agent other
 * than `definitionId` is never kept: `foreignDefinitionId` names its actual
 * agent instead, and no action can be taken on it from here.
 */
export function useAgentRun(definitionId: string, runId: string) {
  const [run, setRun] = useState<AgentRunRecord | null>(null);
  const [foreignDefinitionId, setForeignDefinitionId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<AgentRunAction | null>(null);
  const version = useRef(0);
  const inFlight = useRef(false);
  const activeRef = useRef(true);
  useEffect(() => {
    activeRef.current = true;
    return () => { activeRef.current = false; };
  }, []);

  const record = useCallback((next: AgentRunRecord) => {
    version.current += 1;
    if (next.definitionId !== definitionId) {
      setRun(null);
      setForeignDefinitionId(next.definitionId);
      return;
    }
    if (next.report !== undefined && next.reportedAt !== null) rememberReportPreview(next.id, next.report);
    setRun(next);
  }, [definitionId]);

  const load = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    const sentAt = version.current;
    void getAgentRun(runId)
      .then(loaded => {
        if (!activeRef.current || version.current !== sentAt) return;
        record(loaded);
        setLoadError(null);
      })
      .catch(failure => { if (activeRef.current) setLoadError((failure as Error).message); })
      .finally(() => { inFlight.current = false; });
  }, [record, runId]);

  useEffect(() => {
    setRun(null);
    setForeignDefinitionId(null);
    setLoadError(null);
    load();
  }, [load]);

  const terminal = run ? isTerminalRunState(run.state) : false;
  const watching = run !== null && !terminal;

  useEffect(() => {
    if (!watching) return;
    const timer = window.setInterval(load, AGENT_RUN_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load, watching]);

  const socket = useOptionalSocket();
  const onTaskUpdate = socket?.onTaskUpdate;
  const taskIds = watching ? [run.reportTaskId, run.actionTaskId].filter((id): id is string => Boolean(id)).join(',') : '';
  useEffect(() => {
    if (!onTaskUpdate || !taskIds) return;
    const watched = new Set(taskIds.split(','));
    return onTaskUpdate(payload => { if (watched.has(payload.taskId)) load(); });
  }, [load, onTaskUpdate, taskIds]);

  const act = useCallback(async (action: AgentRunAction, note?: string) => {
    setPendingAction(action);
    setActionError(null);
    try {
      const changed = action === 'approve'
        ? await approveAgentRun(runId, note)
        : action === 'reject' ? await rejectAgentRun(runId) : await cancelAgentRun(runId);
      if (activeRef.current) record(changed);
      return true;
    } catch (failure) {
      if (activeRef.current) setActionError((failure as Error).message);
      return false;
    } finally {
      if (activeRef.current) setPendingAction(null);
    }
  }, [record, runId]);

  return { run, foreignDefinitionId, loadError, actionError, pendingAction, reload: load, act };
}
