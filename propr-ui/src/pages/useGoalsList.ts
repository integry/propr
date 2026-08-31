import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  getGoals, GoalApiError,
  GOALS_SEARCH_MAX_LENGTH,
  type GoalListItem,
} from '../api/goalsApi';
import { useCurrentUser } from '../contexts/AuthContext';
import { useSocket } from '../contexts/useSocket';
import { DEFAULT_GOALS_PAGE_SIZE } from './goalsPageUtils';
import {
  boundedGoalsSearch,
  canonicalGoalsPath,
  goalCreatePath,
  GOALS_CURSOR_HISTORY_PARAM,
  MAX_GOALS_CURSOR_HISTORY,
  readGoalsUrlState,
} from './goalsUrlState';

const INVALIDATION_DELAY_MS = 100;
const EMPTY_GOALS: GoalListItem[] = [];

interface GoalsResult {
  fingerprint: string;
  goals: GoalListItem[];
  nextCursor: string | null;
}

interface GoalsRequestState {
  fingerprint: string;
  loading: boolean;
  error: string | null;
}

export function useGoalsList() {
  const user = useCurrentUser();
  const [searchParams, setSearchParams] = useSearchParams();
  const searchParamsKey = searchParams.toString();
  const url = useMemo(() => readGoalsUrlState(new URLSearchParams(searchParamsKey)), [searchParamsKey]);
  const newGoalPath = useMemo(() => goalCreatePath(new URLSearchParams(searchParamsKey)), [searchParamsKey]);
  const detailReturnTarget = useMemo(() => canonicalGoalsPath(new URLSearchParams(searchParamsKey)), [searchParamsKey]);
  const {
    isConnected,
    onGoalSummaryUpdate,
    subscribeToGoalUpdates,
    unsubscribeFromGoalUpdates,
  } = useSocket();
  const [searchQuery, setSearchQuery] = useState(url.search);
  const authorizationFingerprint = user ? JSON.stringify([
    user.id,
    user.role,
    [...user.permissions].sort(),
    user.authorizationSource,
  ]) : 'anonymous';
  const queryFingerprint = useMemo(() => JSON.stringify([
    authorizationFingerprint,
    DEFAULT_GOALS_PAGE_SIZE,
    url.state,
    url.repository,
    url.search,
    url.cursor ?? null,
  ]), [authorizationFingerprint, url.cursor, url.repository, url.search, url.state]);
  const [result, setResult] = useState<GoalsResult | null>(null);
  const activeResult = result?.fingerprint === queryFingerprint ? result : null;
  const goals = activeResult?.goals ?? EMPTY_GOALS;
  const nextCursor = activeResult?.nextCursor ?? null;
  const goalsRef = useRef(goals);
  const [requestState, setRequestState] = useState<GoalsRequestState>({
    fingerprint: queryFingerprint,
    loading: true,
    error: null,
  });
  const loading = requestState.fingerprint !== queryFingerprint || requestState.loading;
  const error = requestState.fingerprint === queryFingerprint ? requestState.error : null;
  const [refreshSequence, setRefreshSequence] = useState(0);
  const handledRefreshSequenceRef = useRef(0);
  const requestSequenceRef = useRef(0);
  const requestAbortRef = useRef<AbortController | null>(null);
  const requestFingerprintRef = useRef<string | null>(null);
  const trailingRefreshRef = useRef(false);
  const invalidationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousConnectedRef = useRef(isConnected);
  const connectionMountedRef = useRef(false);

  useEffect(() => { goalsRef.current = goals; }, [goals]);

  useEffect(() => {
    if (url.cleanedParams) setSearchParams(url.cleanedParams, { replace: true });
  }, [setSearchParams, url.cleanedParams]);

  useEffect(() => { setSearchQuery(url.search); }, [url.search]);

  const updateParams = useCallback((mutate: (next: URLSearchParams) => void, replace = false) => {
    setSearchParams(previous => {
      const next = new URLSearchParams(previous);
      mutate(next);
      return next;
    }, { replace });
  }, [setSearchParams]);

  const resetCursor = (params: URLSearchParams) => {
    params.delete('cursor');
    params.delete(GOALS_CURSOR_HISTORY_PARAM);
    params.delete('page');
  };

  useEffect(() => {
    if (searchQuery === url.search) return;
    const timer = setTimeout(() => {
      updateParams(next => {
        const normalizedSearch = boundedGoalsSearch(searchQuery);
        if (normalizedSearch) next.set('search', normalizedSearch);
        else next.delete('search');
        resetCursor(next);
      }, true);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, updateParams, url.search]);

  const startRequest = useCallback(() => {
    if (url.cleanedParams || requestAbortRef.current) return;
    const sequence = ++requestSequenceRef.current;
    const controller = new AbortController();
    requestAbortRef.current = controller;
    requestFingerprintRef.current = queryFingerprint;
    setRequestState({ fingerprint: queryFingerprint, loading: true, error: null });
    void getGoals({
      limit: DEFAULT_GOALS_PAGE_SIZE,
      state: url.state === 'all' ? undefined : url.state,
      repository: url.repository || undefined,
      search: url.search || undefined,
      cursor: url.cursor,
    }, { signal: controller.signal })
      .then(data => {
        if (sequence !== requestSequenceRef.current || controller.signal.aborted) return;
        setResult({ fingerprint: queryFingerprint, goals: data.goals, nextCursor: data.nextCursor });
      })
      .catch(caught => {
        if (sequence !== requestSequenceRef.current || controller.signal.aborted) return;
        if (caught instanceof GoalApiError && (caught.status === 403 || caught.status === 404)) {
          setResult(null);
        }
        setRequestState({
          fingerprint: queryFingerprint,
          loading: false,
          error: (caught as Error).message || 'Failed to load goals',
        });
      })
      .finally(() => {
        if (sequence === requestSequenceRef.current && !controller.signal.aborted) {
          setRequestState(current => current.fingerprint === queryFingerprint
            ? { ...current, loading: false }
            : current);
        }
        if (requestAbortRef.current === controller) {
          requestAbortRef.current = null;
          requestFingerprintRef.current = null;
          if (trailingRefreshRef.current) {
            trailingRefreshRef.current = false;
            setRefreshSequence(value => value + 1);
          }
        }
      });
  }, [queryFingerprint, url.cleanedParams, url.cursor, url.repository, url.search, url.state]);

  useEffect(() => {
    setResult(null);
    trailingRefreshRef.current = false;
    if (requestAbortRef.current && requestFingerprintRef.current !== queryFingerprint) {
      requestAbortRef.current.abort();
      requestAbortRef.current = null;
      requestFingerprintRef.current = null;
    }
    startRequest();
  }, [queryFingerprint, startRequest]);

  useEffect(() => {
    if (refreshSequence === handledRefreshSequenceRef.current) return;
    handledRefreshSequenceRef.current = refreshSequence;
    if (requestAbortRef.current) {
      trailingRefreshRef.current = true;
      return;
    }
    startRequest();
  }, [refreshSequence, startRequest]);

  const scheduleInvalidation = useCallback(() => {
    if (invalidationTimerRef.current) return;
    invalidationTimerRef.current = setTimeout(() => {
      invalidationTimerRef.current = null;
      setRefreshSequence(value => value + 1);
    }, INVALIDATION_DELAY_MS);
  }, []);

  useEffect(() => {
    if (!isConnected) return;
    subscribeToGoalUpdates();
    const removeListener = onGoalSummaryUpdate(update => {
      if (update.schemaVersion !== 1) return;
      const current = goalsRef.current.find(goal => goal.goalId === update.goalId);
      if (current && update.version <= current.version && update.latestSequence <= current.latestSequence) return;
      scheduleInvalidation();
    });
    return () => {
      removeListener();
      unsubscribeFromGoalUpdates();
    };
  }, [isConnected, onGoalSummaryUpdate, scheduleInvalidation, subscribeToGoalUpdates, unsubscribeFromGoalUpdates]);

  useEffect(() => {
    if (connectionMountedRef.current && isConnected && !previousConnectedRef.current) scheduleInvalidation();
    previousConnectedRef.current = isConnected;
    connectionMountedRef.current = true;
  }, [isConnected, scheduleInvalidation]);

  useEffect(() => () => {
    requestSequenceRef.current += 1;
    requestAbortRef.current?.abort();
    if (invalidationTimerRef.current) clearTimeout(invalidationTimerRef.current);
  }, []);

  const setStateFilter = useCallback((state: string) => {
    updateParams(next => {
      if (state === 'all') next.delete('state');
      else next.set('state', state);
      resetCursor(next);
    });
  }, [updateParams]);

  const clearSearch = useCallback(() => {
    setSearchQuery('');
    updateParams(next => {
      next.delete('search');
      resetCursor(next);
    });
  }, [updateParams]);

  const updateSearchQuery = useCallback((value: string) => {
    setSearchQuery(Array.from(value).length > GOALS_SEARCH_MAX_LENGTH ? boundedGoalsSearch(value) : value);
  }, []);

  const clearFilters = useCallback(() => {
    updateParams(next => {
      next.delete('state');
      next.delete('repository');
      resetCursor(next);
    });
  }, [updateParams]);

  const nextPage = useCallback(() => {
    if (!nextCursor || url.history.length >= MAX_GOALS_CURSOR_HISTORY) return;
    updateParams(next => {
      const history = [...url.history, url.cursor ?? null];
      next.set('cursor', nextCursor);
      next.set(GOALS_CURSOR_HISTORY_PARAM, JSON.stringify(history));
      next.delete('page');
    });
  }, [nextCursor, updateParams, url.cursor, url.history]);

  const previousPage = useCallback(() => {
    if (url.history.length === 0) return;
    updateParams(next => {
      const history = url.history.slice(0, -1);
      const cursor = url.history.at(-1);
      if (cursor) next.set('cursor', cursor);
      else next.delete('cursor');
      if (history.length > 0) next.set(GOALS_CURSOR_HISTORY_PARAM, JSON.stringify(history));
      else next.delete(GOALS_CURSOR_HISTORY_PARAM);
      next.delete('page');
    });
  }, [updateParams, url.history]);

  return {
    goals,
    loading,
    error,
    isConnected,
    searchQuery,
    stateFilter: url.state,
    repositoryFilter: url.repository,
    appliedSearch: url.search,
    newGoalPath,
    detailReturnTarget,
    currentPage: url.history.length + 1,
    hasPrevious: url.history.length > 0,
    hasNext: nextCursor !== null && url.history.length < MAX_GOALS_CURSOR_HISTORY,
    setSearchQuery: updateSearchQuery,
    setStateFilter,
    clearSearch,
    clearFilters,
    nextPage,
    previousPage,
  };
}
