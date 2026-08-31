import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getGoalCapableModels, type InstanceCatalogAgent } from '@propr/shared';
import {
  cancelGoal, cancelGoalMessage, decodeGoalEvent, getGoal, getGoalEvents, GoalApiError, GoalContractError,
  pauseGoal, requestGoalModel, resumeGoal, sendGoalMessage,
  type GoalDetail, type GoalEvent, type GoalMessage, type GoalRecordV1, type SendGoalMessageParams,
} from '../../api/goalsApi';
import { getInstanceCatalog } from '../../api/proprApi';
import { useCurrentUser } from '../../contexts/AuthContext';
import { useDemoMode } from '../../contexts/DemoModeContext';
import { useSocket } from '../../contexts/useSocket';
import { makeGoalIntentKey, mergeGoalEvents, scopedGoalKey } from './goalDetailUtils';
import { drainGoalEventGap } from './goalReplay';

const PAGE_SIZE = 200; const POLL_INTERVAL_MS = 3_000;
const AUTHORIZATION_PROBE_INTERVAL_MS = 30_000;
const ACCESS_ERROR = 'This goal is unavailable or you no longer have access.';

type ConnectionState = 'connected' | 'recovering' | 'offline';
type GoalAction = 'pause' | 'resume' | 'cancel' | 'model' | 'message' | 'cancel-message' | null;
interface RequestToken { generation: number; identity: string }
interface MessageIntent { fingerprint: string; key: string }

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : 'The goal request failed.';
const isAccessLoss = (error: unknown): boolean => error instanceof GoalApiError && (error.status === 403 || error.status === 404);
const isDefinitiveMessageResult = (error: unknown): boolean =>
  error instanceof GoalContractError || (error instanceof GoalApiError && error.status >= 400 && error.status < 500);
const messageFingerprint = (params: SendGoalMessageParams): string => JSON.stringify({
  body: params.body,
  predefinedKind: params.predefinedKind ?? null,
  retryOfMessageId: params.retryOfMessageId ?? null,
});

export function useGoalDetail(goalId: string) {
  const user = useCurrentUser();
  const { isDemoMode } = useDemoMode();
  const { socket, isConnected } = useSocket();
  const userId = user?.id ?? null;
  const authorizationFingerprint = user
    ? JSON.stringify([user.id, user.role, [...user.permissions].sort(), user.authorizationSource]) : null;
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
  const [fallbackRequired, setFallbackRequired] = useState(false);
  const [loadedIdentity, setLoadedIdentity] = useState<string | null>(null);

  const eventsRef = useRef(events);
  const detailRef = useRef(detail);
  const identityRef = useRef(requestIdentity);
  const transportConnectedRef = useRef(isConnected);
  const generationRef = useRef(0);
  const detailRevisionRef = useRef(0);
  const controllersRef = useRef(new Set<AbortController>());
  const subscriptionCleanupRef = useRef<(() => void) | null>(null);
  const recoveryPromiseRef = useRef<Promise<boolean> | null>(null);
  const recoveryTargetRef = useRef(0); const previousCursorRef = useRef<number | null>(null);
  const refreshControllerRef = useRef<AbortController | null>(null);
  const loadOlderControllerRef = useRef<AbortController | null>(null);
  const actionInFlightRef = useRef<symbol | null>(null);
  const messagePromiseRef = useRef<Promise<boolean> | null>(null);
  const messageIntentRef = useRef<MessageIntent | null>(null);
  identityRef.current = requestIdentity; transportConnectedRef.current = isConnected;
  detailRef.current = detail; eventsRef.current = events;

  const token = useCallback((): RequestToken | null => requestIdentity
    ? { generation: generationRef.current, identity: requestIdentity } : null, [requestIdentity]);
  const current = useCallback((request: RequestToken, controller?: AbortController): boolean =>
    request.generation === generationRef.current
    && request.identity === identityRef.current
    && !controller?.signal.aborted, []);
  const controller = useCallback((): AbortController => {
    const next = new AbortController(); controllersRef.current.add(next); return next;
  }, []);
  const release = useCallback((value: AbortController): void => { controllersRef.current.delete(value); }, []);
  const abortRequests = useCallback(() => {
    for (const active of controllersRef.current) active.abort();
    controllersRef.current.clear();
    refreshControllerRef.current = null;
    loadOlderControllerRef.current = null;
    recoveryPromiseRef.current = null;
  }, []);

  const commitEvents = useCallback((nextEvents: GoalEvent[]) => {
    eventsRef.current = nextEvents; setEvents(nextEvents);
  }, []);

  const invalidateAccess = useCallback((request?: RequestToken) => {
    if (request && !current(request)) return;
    generationRef.current += 1;
    abortRequests();
    subscriptionCleanupRef.current?.();
    subscriptionCleanupRef.current = null;
    detailRef.current = null;
    eventsRef.current = [];
    previousCursorRef.current = null;
    recoveryTargetRef.current = 0; actionInFlightRef.current = null;
    messagePromiseRef.current = null; messageIntentRef.current = null;
    setLoadedIdentity(null); setReplayReady(false); setFallbackRequired(false);
    setDetail(null); setEvents([]); setAgents([]); setHasMoreBefore(false);
    setPendingAction(null); setLoading(false); setLoadingOlder(false); setConnectionState('offline');
    setError(ACCESS_ERROR);
  }, [abortRequests, current]);

  const handleAsyncError = useCallback((caught: unknown, request: RequestToken): boolean => {
    if (!current(request)) return true;
    if (isAccessLoss(caught)) { invalidateAccess(request); return true; }
    return false;
  }, [current, invalidateAccess]);

  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    abortRequests();
    recoveryTargetRef.current = 0; actionInFlightRef.current = null;
    previousCursorRef.current = null;
    messagePromiseRef.current = null; messageIntentRef.current = null;
    subscriptionCleanupRef.current?.(); subscriptionCleanupRef.current = null;
    setDetail(null); setEvents([]); setAgents([]); setError(null); setActionError(null);
    setLoading(true); setLoadingOlder(false); setHasMoreBefore(false); setConnectionState('offline');
    setReplayReady(false); setFallbackRequired(false); setLoadedIdentity(null);
    if (!userId || !requestIdentity) {
      setError('Goal access is unavailable. Sign in again to continue.'); setLoading(false); return;
    }
    const request = { generation, identity: requestIdentity };
    const initialController = controller();
    void (async () => {
      try {
        const authorizedDetail = await getGoal(goalId, { signal: initialController.signal });
        if (authorizedDetail.goal.goalId !== goalId) throw new GoalContractError('response.goal.goalId', `the requested goal ${goalId}`);
        const [page, catalog] = await Promise.all([
          getGoalEvents(goalId, { limit: PAGE_SIZE, signal: initialController.signal }),
          getInstanceCatalog({ signal: initialController.signal }).catch(() => null),
        ]);
        if (!current(request, initialController)) return;
        const initialEvents = mergeGoalEvents([], page.events, goalId);
        detailRef.current = authorizedDetail; eventsRef.current = initialEvents;
        previousCursorRef.current = page.previousCursor;
        setDetail(authorizedDetail); setEvents(initialEvents); setHasMoreBefore(page.hasMoreBefore && page.previousCursor !== null);
        setAgents(catalog?.agents ?? []); setLoadedIdentity(requestIdentity); setReplayReady(true); setError(null);
      } catch (caught) {
        if (!current(request, initialController)) return;
        if (!handleAsyncError(caught, request)) setError(errorMessage(caught));
      } finally {
        release(initialController);
        if (current(request, initialController)) setLoading(false);
      }
    })();
    return () => initialController.abort();
  }, [abortRequests, controller, current, goalId, handleAsyncError, release, requestIdentity, userId]);

  const identityAuthorized = loadedIdentity === requestIdentity;
  const authorizedRepository = identityAuthorized ? detail?.goal.repository ?? null : null;
  const authorizedGoalId = identityAuthorized ? detail?.goal.goalId ?? null : null;

  const refreshDetail = useCallback(async (): Promise<GoalDetail | null> => {
    const request = token(); if (!request) return null;
    const detailRevision = detailRevisionRef.current;
    refreshControllerRef.current?.abort();
    const refreshController = controller(); refreshControllerRef.current = refreshController;
    try {
      const next = await getGoal(goalId, { signal: refreshController.signal });
      if (!current(request, refreshController) || detailRevision !== detailRevisionRef.current) return null;
      if (next.goal.goalId !== goalId) throw new GoalContractError('response.goal.goalId', `the requested goal ${goalId}`);
      detailRef.current = next; setDetail(next); setError(null); return next;
    } catch (caught) {
      if (!handleAsyncError(caught, request) && current(request, refreshController)) {
        setFallbackRequired(true); setConnectionState(transportConnectedRef.current ? 'recovering' : 'offline');
      }
      return null;
    } finally {
      release(refreshController);
      if (refreshControllerRef.current === refreshController) refreshControllerRef.current = null;
    }
  }, [controller, current, goalId, handleAsyncError, release, token]);

  const recoverTail = useCallback((target = 0): Promise<boolean> => {
    recoveryTargetRef.current = Math.max(recoveryTargetRef.current, target);
    if (recoveryPromiseRef.current) return recoveryPromiseRef.current;
    const request = token();
    if (!request) return Promise.resolve(false);
    const recoveryController = controller();
    let recovery: Promise<boolean> | null = null;
    recovery = (async () => {
      try {
        recoveryTargetRef.current = Math.max(recoveryTargetRef.current, detailRef.current?.latestSequence ?? 0);
        let probedCurrentTail = false;
        while (current(request, recoveryController) && !probedCurrentTail) {
          const tail = eventsRef.current.at(-1)?.sequence ?? 0;
          const wanted = recoveryTargetRef.current;
          const replay = await drainGoalEventGap(goalId, tail, tail < wanted ? wanted : null, recoveryController.signal);
          if (!current(request, recoveryController)) return false;
          commitEvents(mergeGoalEvents(eventsRef.current, replay.events, goalId));
          probedCurrentTail = replay.cursor >= recoveryTargetRef.current;
        }
        if (!current(request, recoveryController)) return false;
        setFallbackRequired(!transportConnectedRef.current);
        setConnectionState(transportConnectedRef.current ? 'connected' : 'recovering');
        return true;
      } catch (caught) {
        if (!handleAsyncError(caught, request) && current(request, recoveryController)) {
          setFallbackRequired(true); setConnectionState(transportConnectedRef.current ? 'recovering' : 'offline');
        }
        return false;
      } finally {
        release(recoveryController);
        if (recoveryPromiseRef.current === recovery) recoveryPromiseRef.current = null;
      }
    })();
    recoveryPromiseRef.current = recovery;
    return recovery;
  }, [commitEvents, controller, current, goalId, handleAsyncError, release, token]);

  useEffect(() => {
    if (!authorizedRepository || !userId || !socket || !isConnected || !replayReady) return;
    const request = token(); if (!request) return;
    const room = { ownerId: userId, repository: authorizedRepository, goalId, afterSequence: eventsRef.current.at(-1)?.sequence ?? 0 };
    const expectedScope = scopedGoalKey(userId, authorizedRepository, goalId);
    let subscribed = true;
    const unsubscribe = () => {
      if (!subscribed) return; subscribed = false;
      socket.off('goal:event', handleEvent);
      socket.emit('unsubscribe:goal', { ownerId: userId, repository: authorizedRepository, goalId });
    };
    const handleEvent = (wire: unknown) => {
      if (!current(request)) return;
      try {
        const envelope = wire && typeof wire === 'object' ? wire as Record<string, unknown> : {};
        if (scopedGoalKey(String(envelope.ownerId), String(envelope.repository), String(envelope.goalId)) !== expectedScope) return;
        const event = decodeGoalEvent(envelope.event);
        if (event.goalId !== goalId) return;
        const lastSequence = eventsRef.current.at(-1)?.sequence ?? 0;
        if (event.sequence <= lastSequence) return;
        if (event.sequence > lastSequence + 1) {
          setConnectionState('recovering'); void recoverTail(event.sequence); return;
        }
        commitEvents(mergeGoalEvents(eventsRef.current, [event], goalId));
        if (event.type === 'lifecycle' || event.type === 'message' || event.type === 'usage') void refreshDetail();
      } catch {
        setConnectionState('recovering'); void recoverTail();
      }
    };
    socket.emit('subscribe:goal', room); socket.on('goal:event', handleEvent);
    subscriptionCleanupRef.current = unsubscribe;
    setConnectionState('recovering');
    void recoverTail(detailRef.current?.latestSequence ?? 0);
    return () => { unsubscribe(); if (subscriptionCleanupRef.current === unsubscribe) subscriptionCleanupRef.current = null; };
  }, [authorizedRepository, commitEvents, current, goalId, isConnected, refreshDetail, recoverTail, replayReady, socket, token, userId]);

  useEffect(() => {
    if (!authorizedGoalId || !replayReady || (isConnected && !fallbackRequired)) return;
    let active = true;
    let timer: number | null = null;
    const poll = async () => {
      const fresh = await refreshDetail();
      if (fresh) await recoverTail(fresh.latestSequence);
      if (active) timer = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
    };
    void poll();
    return () => { active = false; if (timer !== null) window.clearTimeout(timer); };
  }, [authorizedGoalId, fallbackRequired, isConnected, recoverTail, refreshDetail, replayReady]);

  useEffect(() => {
    if (!authorizedGoalId || !replayReady || !isConnected || fallbackRequired) return;
    let active = true;
    let timer: number | null = null;
    const probe = async () => {
      const fresh = await refreshDetail();
      const loadedTail = eventsRef.current.at(-1)?.sequence ?? 0;
      if (fresh && fresh.latestSequence > loadedTail) await recoverTail(fresh.latestSequence);
      if (active) timer = window.setTimeout(() => void probe(), AUTHORIZATION_PROBE_INTERVAL_MS);
    };
    timer = window.setTimeout(() => void probe(), AUTHORIZATION_PROBE_INTERVAL_MS);
    return () => { active = false; if (timer !== null) window.clearTimeout(timer); };
  }, [authorizedGoalId, fallbackRequired, isConnected, recoverTail, refreshDetail, replayReady]);

  const loadOlder = useCallback(async () => {
    const beforeSequence = previousCursorRef.current;
    if (beforeSequence === null || loadingOlder || !hasMoreBefore) return;
    const request = token(); if (!request) return;
    loadOlderControllerRef.current?.abort();
    const olderController = controller(); loadOlderControllerRef.current = olderController;
    setLoadingOlder(true);
    try {
      const page = await getGoalEvents(goalId, { beforeSequence, limit: PAGE_SIZE, signal: olderController.signal });
      if (!current(request, olderController)) return;
      const cursorMadeProgress = page.previousCursor !== null && page.previousCursor !== beforeSequence;
      previousCursorRef.current = page.previousCursor;
      commitEvents(mergeGoalEvents(eventsRef.current, page.events, goalId));
      setHasMoreBefore(page.hasMoreBefore && cursorMadeProgress);
      if (page.hasMoreBefore && !cursorMadeProgress) {
        setActionError('Older goal history stopped because the server repeated or omitted its pagination cursor.');
      }
    } catch (caught) {
      if (!handleAsyncError(caught, request) && current(request, olderController)) setActionError(errorMessage(caught));
    } finally {
      release(olderController);
      if (current(request, olderController)) setLoadingOlder(false);
      if (loadOlderControllerRef.current === olderController) loadOlderControllerRef.current = null;
    }
  }, [commitEvents, controller, current, goalId, handleAsyncError, hasMoreBefore, loadingOlder, release, token]);

  const runMutation = useCallback(async (
    action: Exclude<GoalAction, 'message' | 'cancel-message' | null>,
    requestMutation: (version: number, key: string) => Promise<GoalRecordV1>
  ) => {
    const request = token(); const activeDetail = detailRef.current;
    if (!request || !activeDetail || actionInFlightRef.current !== null || isDemoMode) return false;
    const actionRequest = Symbol(action);
    actionInFlightRef.current = actionRequest; setPendingAction(action); setActionError(null);
    try {
      const goal = await requestMutation(activeDetail.goal.version, makeGoalIntentKey());
      if (!current(request)) return false;
      detailRevisionRef.current += 1;
      setDetail(existing => existing ? { ...existing, goal: { ...existing.goal, ...goal } } : existing); return true;
    } catch (caught) {
      if (handleAsyncError(caught, request)) return false;
      if (caught instanceof GoalApiError && caught.code === 'goal_version_conflict') {
        await refreshDetail();
        if (current(request)) setActionError('The goal changed in another operator session. It was refreshed; review the new state and try again.');
      } else if (current(request)) setActionError(errorMessage(caught));
      return false;
    } finally {
      if (actionInFlightRef.current === actionRequest) {
        actionInFlightRef.current = null; if (current(request)) setPendingAction(null);
      }
    }
  }, [current, handleAsyncError, isDemoMode, refreshDetail, token]);

  const replaceMessage = useCallback((message: GoalMessage) => {
    detailRevisionRef.current += 1;
    setDetail(existing => existing ? { ...existing, messages: [...existing.messages.filter(item => item.messageId !== message.messageId), message].sort((a, b) => a.sequence - b.sequence) } : existing);
  }, []);

  const sendMessage = useCallback((params: SendGoalMessageParams): Promise<boolean> => {
    if (messagePromiseRef.current) return messagePromiseRef.current;
    const request = token();
    if (!request || !detailRef.current || actionInFlightRef.current !== null || isDemoMode) return Promise.resolve(false);
    const fingerprint = messageFingerprint(params);
    if (messageIntentRef.current?.fingerprint !== fingerprint) messageIntentRef.current = { fingerprint, key: makeGoalIntentKey() };
    const intent = messageIntentRef.current;
    const actionRequest = Symbol('message');
    actionInFlightRef.current = actionRequest; setPendingAction('message'); setActionError(null);
    let promise: Promise<boolean> | null = null;
    promise = (async () => {
      try {
        const message = await sendGoalMessage(goalId, params, intent.key);
        if (!current(request)) return false;
        messageIntentRef.current = null; replaceMessage(message); return true;
      } catch (caught) {
        if (isDefinitiveMessageResult(caught)) messageIntentRef.current = null;
        if (!handleAsyncError(caught, request) && current(request)) setActionError(errorMessage(caught));
        return false;
      } finally {
        if (messagePromiseRef.current === promise) messagePromiseRef.current = null;
        if (actionInFlightRef.current === actionRequest) {
          actionInFlightRef.current = null; if (current(request)) setPendingAction(null);
        }
      }
    })();
    messagePromiseRef.current = promise; return promise;
  }, [current, goalId, handleAsyncError, isDemoMode, replaceMessage, token]);

  const cancelMessage = useCallback(async (messageId: string) => {
    const request = token(); if (!request || actionInFlightRef.current !== null || isDemoMode) return;
    const actionRequest = Symbol('cancel-message');
    actionInFlightRef.current = actionRequest; setPendingAction('cancel-message'); setActionError(null);
    try {
      const message = await cancelGoalMessage(goalId, messageId, makeGoalIntentKey());
      if (current(request)) replaceMessage(message);
    } catch (caught) {
      if (!handleAsyncError(caught, request) && current(request)) setActionError(errorMessage(caught));
    } finally {
      if (actionInFlightRef.current === actionRequest) {
        actionInFlightRef.current = null; if (current(request)) setPendingAction(null);
      }
    }
  }, [current, goalId, handleAsyncError, isDemoMode, replaceMessage, token]);

  const goalModels = useMemo(() => {
    if (!identityAuthorized) return [];
    const agent = agents.find(item => item.alias === detail?.goal.agent);
    return agent ? getGoalCapableModels(agent) : [];
  }, [agents, detail?.goal.agent, identityAuthorized]);

  return {
    detail: identityAuthorized ? detail : null, events: identityAuthorized ? events : [],
    loading: loading || (requestIdentity !== null && !identityAuthorized && error === null),
    error, actionError, pendingAction, connectionState, hasMoreBefore, loadingOlder, goalModels,
    readOnly: isDemoMode || !userId || !identityAuthorized, loadOlder,
    pause: () => runMutation('pause', (version, key) => pauseGoal(goalId, version, key)),
    resume: () => runMutation('resume', (version, key) => resumeGoal(goalId, version, key)),
    cancel: (reason: string) => runMutation('cancel', (version, key) => cancelGoal(goalId, version, reason, key)),
    changeModel: (model: string) => runMutation('model', (version, key) => requestGoalModel(goalId, version, model, key)),
    sendMessage,
    retryMessage: (message: GoalMessage) => sendMessage({ body: message.body, predefinedKind: message.predefinedKind ?? undefined, retryOfMessageId: message.messageId }),
    cancelMessage,
  };
}
