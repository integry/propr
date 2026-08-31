import {
  GOALS_CURSOR_MAX_LENGTH,
  GOALS_SEARCH_MAX_LENGTH,
  GOAL_STATES,
  type GoalState,
} from '../api/goalsApi';

export const GOALS_CURSOR_HISTORY_PARAM = 'cursorHistory';
export const GOALS_RETURN_TO_PARAM = 'returnTo';
export const MAX_GOALS_CURSOR_HISTORY = 100;
const REPOSITORY_MAX_LENGTH = 255;
const GOALS_PATH = '/goals';

export const validGoalsCursor = (value: string): boolean =>
  value.length > 0
  && value.length <= GOALS_CURSOR_MAX_LENGTH
  && /^[A-Za-z0-9_-]+$/.test(value);

export const boundedGoalsSearch = (value: string): string =>
  Array.from(value.trim()).slice(0, GOALS_SEARCH_MAX_LENGTH).join('');

const setOptionalParam = (params: URLSearchParams, key: string, value: string): void => {
  if (value) params.set(key, value);
  else params.delete(key);
};

export interface GoalsUrlState {
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
    if (!Array.isArray(value) || value.length > MAX_GOALS_CURSOR_HISTORY) return null;
    if (!value.every(cursor => cursor === null || (typeof cursor === 'string' && validGoalsCursor(cursor)))) return null;
    if (value.slice(1).some(cursor => cursor === null)) return null;
    return value as Array<string | null>;
  } catch {
    return null;
  }
}

function readGoalState(
  params: URLSearchParams,
  cleaned: URLSearchParams
): { state: GoalState | 'all'; changed: boolean } {
  const rawState = params.get('state');
  const state = rawState && GOAL_STATES.includes(rawState as GoalState)
    ? rawState as GoalState
    : 'all';
  if (!rawState || state !== 'all') return { state, changed: false };
  cleaned.delete('state');
  return { state, changed: true };
}

export function readGoalsUrlState(params: URLSearchParams): GoalsUrlState {
  const cleaned = new URLSearchParams(params);
  const goalState = readGoalState(params, cleaned);
  let changed = goalState.changed;

  const rawRepository = params.get('repository') ?? '';
  const repository = rawRepository.length <= REPOSITORY_MAX_LENGTH ? rawRepository : '';
  if (rawRepository && !repository) {
    cleaned.delete('repository');
    changed = true;
  }

  const rawSearch = params.get('search') ?? '';
  const search = boundedGoalsSearch(rawSearch);
  if (search !== rawSearch) {
    setOptionalParam(cleaned, 'search', search);
    changed = true;
  }

  const rawCursor = params.get('cursor');
  const cursor = rawCursor && validGoalsCursor(rawCursor) ? rawCursor : undefined;
  let history = parseCursorHistory(params.get(GOALS_CURSOR_HISTORY_PARAM));
  if ((rawCursor && !cursor) || history === null) {
    cleaned.delete('cursor');
    cleaned.delete(GOALS_CURSOR_HISTORY_PARAM);
    history = [];
    changed = true;
  }
  if (!cursor && history.length > 0) {
    cleaned.delete(GOALS_CURSOR_HISTORY_PARAM);
    history = [];
    changed = true;
  }
  if (history.length === 0 && params.has(GOALS_CURSOR_HISTORY_PARAM)) {
    cleaned.delete(GOALS_CURSOR_HISTORY_PARAM);
    changed = true;
  }
  if (params.has('page')) {
    cleaned.delete('page');
    changed = true;
  }
  return { state: goalState.state, repository, search, cursor, history, cleanedParams: changed ? cleaned : null };
}

export function canonicalGoalsPath(params: URLSearchParams): string {
  const url = readGoalsUrlState(params);
  const canonical = new URLSearchParams();
  if (url.state !== 'all') canonical.set('state', url.state);
  if (url.repository) canonical.set('repository', url.repository);
  if (url.search) canonical.set('search', url.search);
  if (url.cursor) canonical.set('cursor', url.cursor);
  if (url.cursor && url.history.length > 0) {
    canonical.set(GOALS_CURSOR_HISTORY_PARAM, JSON.stringify(url.history));
  }
  const query = canonical.toString();
  return `${GOALS_PATH}${query ? `?${query}` : ''}`;
}

export function goalCreatePath(params: URLSearchParams): string {
  const query = new URLSearchParams({ [GOALS_RETURN_TO_PARAM]: canonicalGoalsPath(params) });
  return `/goals/new?${query.toString()}`;
}

export function goalDetailPath(goalId: string, params: URLSearchParams): string {
  const query = new URLSearchParams({ [GOALS_RETURN_TO_PARAM]: canonicalGoalsPath(params) });
  return `/goals/${encodeURIComponent(goalId)}?${query.toString()}`;
}

export function goalsReturnTarget(rawTarget: string | null): string {
  if (!rawTarget || !rawTarget.startsWith('/') || rawTarget.startsWith('//')) return GOALS_PATH;
  try {
    const base = 'https://propr.invalid';
    const target = new URL(rawTarget, base);
    if (target.origin !== base || target.pathname !== GOALS_PATH || target.hash) return GOALS_PATH;
    return canonicalGoalsPath(target.searchParams);
  } catch {
    return GOALS_PATH;
  }
}
