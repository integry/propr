import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  getGoals,
  GOALS_CURSOR_MAX_LENGTH,
  GOALS_SEARCH_MAX_LENGTH,
  GOAL_STATES,
  type GoalListItem,
  type GoalState,
} from '../api/goalsApi';
import { useSocket } from '../contexts/useSocket';
import { DEFAULT_GOALS_PAGE_SIZE } from './goalsPageUtils';

const CURSOR_HISTORY_PARAM = 'cursorHistory';
const REPOSITORY_MAX_LENGTH = 255;
const MAX_CURSOR_HISTORY = 100;
const INVALIDATION_DELAY_MS = 100;

const validCursor = (value: string): boolean =>
  value.length > 0
  && value.length <= GOALS_CURSOR_MAX_LENGTH
  && /^[A-Za-z0-9_-]+$/.test(value);

const boundedSearch = (value: string): string =>
  Array.from(value.trim()).slice(0, GOALS_SEARCH_MAX_LENGTH).join('');

const setOptionalParam = (params: URLSearchParams, key: string, value: string): void => {
  if (value) params.set(key, value);
  else params.delete(key);
};

interface GoalsUrlState {
  state: GoalState | 'all';
  repository: string;
  search: string;
  cursor?: string;
  history: Array<string | null>;
  cleanedParams: URLSearchParams | null;
}

function parseCursorHistory(raw: string | null): Array<string | null> | null {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value) || value.length > MAX_CURSOR_HISTORY) return null;
    if (!value.every(cursor => cursor === null || (typeof cursor === 'string' && validCursor(cursor)))) return null;
    return value as Array<string | null>;
  } catch {
    return null;
  }
}

function readUrlState(params: URLSearchParams): GoalsUrlState {
  const cleaned = new URLSearchParams(params);
  let changed = false;
  const rawState = params.get('state');
  const state = rawState && GOAL_STATES.includes(rawState as GoalState)
    ? rawState as GoalState
    : 'all';
  if (rawState && state === 'all') {
    cleaned.delete('state');
    changed = true;
  }

  const rawRepository = params.get('repository') ?? '';
  const repository = rawRepository.length <= REPOSITORY_MAX_LENGTH ? rawRepository : '';
  if (rawRepository && !repository) {
    cleaned.delete('repository');
    changed = true;
  }

  const rawSearch = params.get('search') ?? '';
  const search = boundedSearch(rawSearch);
  if (search !== rawSearch) {
    setOptionalParam(cleaned, 'search', search);
    changed = true;
  }

  const rawCursor = params.get('cursor');
  const cursor = rawCursor && validCursor(rawCursor) ? rawCursor : undefined;
  let history = parseCursorHistory(params.get(CURSOR_HISTORY_PARAM));
  if ((rawCursor && !cursor) || history === null) {
    cleaned.delete('cursor');
    cleaned.delete(CURSOR_HISTORY_PARAM);
    history = [];
    changed = true;
  }
  if (!cursor && history.length > 0) {
    cleaned.delete(CURSOR_HISTORY_PARAM);
    history = [];
    changed = true;
  }
  if (params.has('page')) {
    cleaned.delete('page');
    changed = true;
  }
  return { state, repository, search, cursor, history, cleanedParams: changed ? cleaned : null };
}

export function useGoalsList() {
  const [searchParams, setSearchParams] = useSearchParams();
  const searchParamsKey = searchParams.toString();
  const url = useMemo(() => readUrlState(new URLSearchParams(searchParamsKey)), [searchParamsKey]);
  const {
    isConnected,
    onGoalSummaryUpdate,
    subscribeToGoalUpdates,
    unsubscribeFromGoalUpdates,
  } = useSocket();
  const [searchQuery, setSearchQuery] = useState(url.search);
  const [goals, setGoals] = useState<GoalListItem[]>([]);
  const goalsRef = useRef(goals);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshSequence, setRefreshSequence] = useState(0);
  const requestSequenceRef = useRef(0);
  const requestAbortRef = useRef<AbortController | null>(null);
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
    params.delete(CURSOR_HISTORY_PARAM);
    params.delete('page');
  };

  useEffect(() => {
    if (searchQuery === url.search) return;
    const timer = setTimeout(() => {
      updateParams(next => {
        const normalizedSearch = boundedSearch(searchQuery);
        if (normalizedSearch) next.set('search', normalizedSearch);
        else next.delete('search');
        resetCursor(next);
      }, true);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, updateParams, url.search]);

  useEffect(() => {
    if (url.cleanedParams) return;
    const sequence = ++requestSequenceRef.current;
    requestAbortRef.current?.abort();
    const controller = new AbortController();
    requestAbortRef.current = controller;
    setLoading(true);
    setError(null);
    void getGoals({
      limit: DEFAULT_GOALS_PAGE_SIZE,
      state: url.state === 'all' ? undefined : url.state,
      repository: url.repository || undefined,
      search: url.search || undefined,
      cursor: url.cursor,
    }, { signal: controller.signal })
      .then(data => {
        if (sequence !== requestSequenceRef.current || controller.signal.aborted) return;
        setGoals(data.goals);
        setNextCursor(data.nextCursor);
      })
      .catch(caught => {
        if (sequence !== requestSequenceRef.current || controller.signal.aborted) return;
        setError((caught as Error).message || 'Failed to load goals');
      })
      .finally(() => {
        if (sequence === requestSequenceRef.current && !controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [refreshSequence, url.cleanedParams, url.cursor, url.repository, url.search, url.state]);

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
    setSearchQuery(Array.from(value).length > GOALS_SEARCH_MAX_LENGTH ? boundedSearch(value) : value);
  }, []);

  const clearFilters = useCallback(() => {
    updateParams(next => {
      next.delete('state');
      next.delete('repository');
      resetCursor(next);
    });
  }, [updateParams]);

  const nextPage = useCallback(() => {
    if (!nextCursor) return;
    updateParams(next => {
      const history = [...url.history, url.cursor ?? null];
      next.set('cursor', nextCursor);
      next.set(CURSOR_HISTORY_PARAM, JSON.stringify(history));
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
      if (history.length > 0) next.set(CURSOR_HISTORY_PARAM, JSON.stringify(history));
      else next.delete(CURSOR_HISTORY_PARAM);
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
    currentPage: url.history.length + 1,
    hasPrevious: url.history.length > 0,
    hasNext: nextCursor !== null,
    setSearchQuery: updateSearchQuery,
    setStateFilter,
    clearSearch,
    clearFilters,
    nextPage,
    previousPage,
  };
}
