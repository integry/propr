import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { InstanceCatalogAgent } from '@propr/shared';
import {
  cancelGoal,
  cancelGoalMessage,
  decodeGoalEvent,
  getGoal,
  getGoalEvents,
  GoalApiError,
  pauseGoal,
  requestGoalModel,
  resumeGoal,
  sendGoalMessage,
  type GoalDetail,
  type GoalEvent,
  type GoalMessage,
  type GoalRecordV1,
  type SendGoalMessageParams,
} from '../../api/goalsApi';
import { getInstanceCatalog } from '../../api/proprApi';
import { useCurrentUser } from '../../contexts/AuthContext';
import { useDemoMode } from '../../contexts/DemoModeContext';
import { useSocket } from '../../contexts/useSocket';
import { getGoalCapableModels } from '@propr/shared';
import { makeGoalIntentKey, mergeGoalEvents, scopedGoalKey } from './goalDetailUtils';

const PAGE_SIZE = 200;
const POLL_INTERVAL_MS = 3_000;

type ConnectionState = 'connected' | 'recovering' | 'offline';
type GoalAction = 'pause' | 'resume' | 'cancel' | 'model' | 'message' | 'cancel-message' | null;

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : 'The goal request failed.';

export function useGoalDetail(goalId: string) {
  const user = useCurrentUser();
  const { isDemoMode } = useDemoMode();
  const { socket, isConnected } = useSocket();
  const userId = user?.id ?? null;
  const authorizationFingerprint = user
    ? JSON.stringify([user.id, user.role, [...user.permissions].sort(), user.authorizationSource])
    : null;
  const requestIdentity = authorizationFingerprint ? JSON.stringify([authorizationFingerprint, goalId]) : null;
  const [detail, setDetail] = useState<GoalDetail | null>(null);
  const [events, setEvents] = useState<GoalEvent[]>([]);
  const [agents, setAgents] = useState<InstanceCatalogAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMoreBefore, setHasMoreBefore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<GoalAction>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>('offline');
  const [replayReady, setReplayReady] = useState(false);
  const [loadedIdentity, setLoadedIdentity] = useState<string | null>(null);
  const eventsRef = useRef(events);
  const detailRef = useRef(detail);
  const requestGenerationRef = useRef(0);

  useEffect(() => { eventsRef.current = events; }, [events]);
  useEffect(() => { detailRef.current = detail; }, [detail]);

  const replaceMessage = useCallback((message: GoalMessage) => {
    setDetail(current => current ? {
      ...current,
      messages: [...current.messages.filter(item => item.messageId !== message.messageId), message]
        .sort((left, right) => left.sequence - right.sequence),
    } : current);
  }, []);

  const refreshDetail = useCallback(async (signal?: AbortSignal) => {
    const next = await getGoal(goalId, { signal });
    setDetail(next);
    setError(null);
    return next;
  }, [goalId]);

  const tailFrom = useCallback(async (afterSequence: number, signal?: AbortSignal) => {
    const page = await getGoalEvents(goalId, { afterSequence, limit: PAGE_SIZE, signal });
    setEvents(current => mergeGoalEvents(current, page.events, goalId));
    return page;
  }, [goalId]);

  useEffect(() => {
    const generation = ++requestGenerationRef.current;
    const controller = new AbortController();
    setDetail(null);
    setEvents([]);
    setAgents([]);
    setError(null);
    setActionError(null);
    setLoading(true);
    setConnectionState('offline');
    setReplayReady(false);
    setLoadedIdentity(null);
    if (!userId || !requestIdentity) {
      setError('Goal access is unavailable. Sign in again to continue.');
      setLoading(false);
      return () => controller.abort();
    }
    void (async () => {
      try {
        const authorizedDetail = await getGoal(goalId, { signal: controller.signal });
        if (generation !== requestGenerationRef.current) return;
        setDetail(authorizedDetail);
        const [page, catalog] = await Promise.all([
          getGoalEvents(goalId, { limit: PAGE_SIZE, signal: controller.signal }),
          getInstanceCatalog().catch(() => null),
        ]);
        if (generation !== requestGenerationRef.current) return;
        setEvents(mergeGoalEvents([], page.events, goalId));
        setHasMoreBefore(page.hasMoreBefore);
        setReplayReady(true);
        setLoadedIdentity(requestIdentity);
        if (catalog) setAgents(catalog.agents);
      } catch (caught) {
        if (controller.signal.aborted || generation !== requestGenerationRef.current) return;
        setDetail(null);
        setEvents([]);
        setError(caught instanceof GoalApiError && (caught.status === 403 || caught.status === 404)
          ? 'This goal is unavailable or you no longer have access.'
          : errorMessage(caught));
      } finally {
        if (!controller.signal.aborted && generation === requestGenerationRef.current) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [goalId, requestIdentity, userId]);

  const identityAuthorized = loadedIdentity === requestIdentity;
  const authorizedRepository = identityAuthorized ? detail?.goal.repository ?? null : null;
  const authorizedGoalId = identityAuthorized ? detail?.goal.goalId ?? null : null;

  useEffect(() => {
    if (!authorizedRepository || !userId || !socket || !isConnected || !replayReady) return;
    const room = {
      ownerId: userId,
      repository: authorizedRepository,
      goalId,
      afterSequence: eventsRef.current.at(-1)?.sequence ?? 0,
    };
    const expectedScope = scopedGoalKey(userId, authorizedRepository, goalId);
    const handleEvent = (wire: unknown) => {
      try {
        const envelope = wire && typeof wire === 'object' ? wire as Record<string, unknown> : {};
        if (scopedGoalKey(String(envelope.ownerId), String(envelope.repository), String(envelope.goalId)) !== expectedScope) return;
        const event = decodeGoalEvent(envelope.event);
        const lastSequence = eventsRef.current.at(-1)?.sequence ?? 0;
        if (event.sequence <= lastSequence && eventsRef.current.some(item => item.sequence === event.sequence)) return;
        if (event.sequence > lastSequence + 1) {
          setConnectionState('recovering');
          void tailFrom(lastSequence).then(() => setConnectionState('connected')).catch(() => setConnectionState('offline'));
          return;
        }
        setEvents(current => mergeGoalEvents(current, [event], goalId));
        if (event.type === 'lifecycle' || event.type === 'message' || event.type === 'usage') {
          void refreshDetail().catch(() => setConnectionState('recovering'));
        }
      } catch {
        setConnectionState('recovering');
      }
    };
    socket.emit('subscribe:goal', room);
    socket.on('goal:event', handleEvent);
    setConnectionState('connected');
    const cursor = eventsRef.current.at(-1)?.sequence ?? 0;
    void tailFrom(cursor).catch(() => setConnectionState('recovering'));
    return () => {
      socket.off('goal:event', handleEvent);
      socket.emit('unsubscribe:goal', { ownerId: userId, repository: authorizedRepository, goalId });
    };
  }, [authorizedRepository, goalId, isConnected, refreshDetail, replayReady, socket, tailFrom, userId]);

  useEffect(() => {
    if (!authorizedGoalId || isConnected || !replayReady) return;
    setConnectionState('recovering');
    let active = true;
    const poll = async () => {
      const cursor = eventsRef.current.at(-1)?.sequence ?? 0;
      try {
        await Promise.all([tailFrom(cursor), refreshDetail()]);
        if (active) setConnectionState('recovering');
      } catch (caught) {
        if (!active) return;
        if (caught instanceof GoalApiError && (caught.status === 403 || caught.status === 404)) {
          setDetail(null);
          setEvents([]);
          setError('This goal is unavailable or you no longer have access.');
        }
        setConnectionState('offline');
      }
    };
    void poll();
    const interval = window.setInterval(poll, POLL_INTERVAL_MS);
    return () => { active = false; window.clearInterval(interval); };
  }, [authorizedGoalId, isConnected, refreshDetail, replayReady, tailFrom]);

  const loadOlder = useCallback(async () => {
    const first = eventsRef.current[0]?.sequence;
    if (first === undefined || loadingOlder || !hasMoreBefore) return;
    setLoadingOlder(true);
    try {
      const page = await getGoalEvents(goalId, { beforeSequence: first, limit: PAGE_SIZE });
      setEvents(current => mergeGoalEvents(current, page.events, goalId));
      setHasMoreBefore(page.hasMoreBefore);
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setLoadingOlder(false);
    }
  }, [goalId, hasMoreBefore, loadingOlder]);

  const runMutation = useCallback(async (
    action: Exclude<GoalAction, 'message' | 'cancel-message' | null>,
    request: (version: number, key: string) => Promise<GoalRecordV1>
  ) => {
    const current = detailRef.current;
    if (!current || pendingAction || isDemoMode) return false;
    setPendingAction(action);
    setActionError(null);
    try {
      const goal = await request(current.goal.version, makeGoalIntentKey());
      setDetail(existing => existing ? { ...existing, goal: { ...existing.goal, ...goal } } : existing);
      return true;
    } catch (caught) {
      if (caught instanceof GoalApiError && caught.code === 'goal_version_conflict') {
        await refreshDetail().catch(() => undefined);
        setActionError('The goal changed in another operator session. It was refreshed; review the new state and try again.');
      } else setActionError(errorMessage(caught));
      return false;
    } finally {
      setPendingAction(null);
    }
  }, [isDemoMode, pendingAction, refreshDetail]);

  const sendMessage = useCallback(async (params: SendGoalMessageParams) => {
    if (!detailRef.current || pendingAction || isDemoMode) return false;
    setPendingAction('message');
    setActionError(null);
    try {
      replaceMessage(await sendGoalMessage(goalId, params, makeGoalIntentKey()));
      return true;
    } catch (caught) {
      setActionError(errorMessage(caught));
      return false;
    } finally {
      setPendingAction(null);
    }
  }, [goalId, isDemoMode, pendingAction, replaceMessage]);

  const cancelMessage = useCallback(async (messageId: string) => {
    if (pendingAction || isDemoMode) return;
    setPendingAction('cancel-message');
    try {
      replaceMessage(await cancelGoalMessage(goalId, messageId, makeGoalIntentKey()));
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setPendingAction(null);
    }
  }, [goalId, isDemoMode, pendingAction, replaceMessage]);

  const goalModels = useMemo(() => {
    if (!identityAuthorized) return [];
    const agent = agents.find(item => item.alias === detail?.goal.agent);
    return agent ? getGoalCapableModels(agent) : [];
  }, [agents, detail?.goal.agent, identityAuthorized]);

  return {
    detail: identityAuthorized ? detail : null,
    events: identityAuthorized ? events : [],
    loading: loading || (requestIdentity !== null && !identityAuthorized && error === null),
    error, actionError, pendingAction, connectionState,
    hasMoreBefore, loadingOlder, goalModels, readOnly: isDemoMode || !userId,
    loadOlder,
    pause: () => runMutation('pause', (version, key) => pauseGoal(goalId, version, key)),
    resume: () => runMutation('resume', (version, key) => resumeGoal(goalId, version, key)),
    cancel: (reason: string) => runMutation('cancel', (version, key) => cancelGoal(goalId, version, reason, key)),
    changeModel: (model: string) => runMutation('model', (version, key) => requestGoalModel(goalId, version, model, key)),
    sendMessage,
    retryMessage: (message: GoalMessage) => sendMessage({ body: message.body, predefinedKind: message.predefinedKind ?? undefined, retryOfMessageId: message.messageId }),
    cancelMessage,
  };
}
