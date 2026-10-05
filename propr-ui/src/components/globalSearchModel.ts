// View model for the global search palette: one linear, keyboard-navigable
// list of results (grouped by type) plus the category scopes above it.
import type { MonitoredRepo } from '../api/proprApi';
import type { DraftListItem } from '../api/plannerApi';
import type { GlobalSearchResults, TaskSearchResult } from '../hooks/useGlobalSearch';

export type SearchCategory = 'all' | 'repositories' | 'plans' | 'tasks';

export type SearchItem =
  | { kind: 'repository'; key: string; repo: MonitoredRepo }
  | { kind: 'plan'; key: string; plan: DraftListItem }
  | { kind: 'task'; key: string; task: TaskSearchResult };

export const SEARCH_CATEGORIES: ReadonlyArray<{ id: SearchCategory; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'repositories', label: 'Repos' },
  { id: 'plans', label: 'Plans' },
  { id: 'tasks', label: 'Tasks' },
];

export const SECTION_LABELS: Record<SearchItem['kind'], string> = {
  repository: 'Repositories',
  plan: 'Plans',
  task: 'Tasks',
};

/** DOM id of a result row, for `aria-activedescendant` and scroll-into-view. */
export const searchOptionId = (key: string) => `global-search-option-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

export function getCategoryCounts(results: GlobalSearchResults): Record<SearchCategory, number> {
  const repositories = results.repositories.length;
  const plans = results.plans.length;
  const tasks = results.tasks.length;
  return { all: repositories + plans + tasks, repositories, plans, tasks };
}

/** Results in display order: repositories, then plans, then tasks. Empty sections simply vanish. */
export function buildSearchItems(results: GlobalSearchResults, category: SearchCategory): SearchItem[] {
  const items: SearchItem[] = [];
  if (category === 'all' || category === 'repositories') {
    items.push(...results.repositories.map(repo => ({ kind: 'repository' as const, key: `repo:${repo.id}`, repo })));
  }
  if (category === 'all' || category === 'plans') {
    items.push(...results.plans.map(plan => ({ kind: 'plan' as const, key: `plan:${plan.draft_id}`, plan })));
  }
  if (category === 'all' || category === 'tasks') {
    items.push(...results.tasks.map(task => ({ kind: 'task' as const, key: `task:${task.id}`, task })));
  }
  return items;
}

/** The next non-empty category in Tab order (`step` -1 for Shift+Tab). `all` is always reachable. */
export function cycleCategory(
  current: SearchCategory,
  counts: Record<SearchCategory, number>,
  step: 1 | -1,
): SearchCategory {
  const ids = SEARCH_CATEGORIES.map(category => category.id);
  let index = ids.indexOf(current);
  for (let i = 0; i < ids.length; i += 1) {
    index = (index + step + ids.length) % ids.length;
    if (ids[index] === 'all' || counts[ids[index]] > 0) return ids[index];
  }
  return current;
}

/** In-app route an item opens. */
export function getItemPath(item: SearchItem): string {
  switch (item.kind) {
    case 'repository':
      return `/tasks?repository=${encodeURIComponent(item.repo.name)}`;
    case 'plan':
      return `/studio/${item.plan.draft_id}`;
    case 'task':
      return `/tasks/${item.task.id}`;
  }
}

/**
 * The footer escape hatch for the active scope: its label names what it searches and its route
 * is the full page for that scope. There is no combined results page, so "All" lands on the
 * task search, the only page that searches across every repository.
 */
export function getScopeAction(category: SearchCategory, query: string): { label: string; path: string } {
  const term = query.trim();
  const search = `search=${encodeURIComponent(term)}`;
  switch (category) {
    case 'all':
      return { label: `View all results for "${term}"`, path: `/tasks?${search}` };
    case 'repositories':
      return { label: 'View all repositories', path: '/repositories' };
    case 'plans':
      return { label: `Search all plans for "${term}"`, path: `/plans?${search}` };
    case 'tasks':
      return { label: `Search all tasks for "${term}"`, path: `/tasks?${search}` };
  }
}

/**
 * The "All" scope's full search lands on tasks, so when plans matched it also offers the full
 * plan search: the palette only holds the first few plans.
 */
export function getPlansAction(
  category: SearchCategory,
  counts: Record<SearchCategory, number>,
  query: string,
): { label: string; path: string } | null {
  return category === 'all' && counts.plans > 0 ? getScopeAction('plans', query) : null;
}

/** GitHub page for an item, when it has one. */
export function getItemGithubUrl(item: SearchItem): string | null {
  switch (item.kind) {
    case 'repository':
      return `https://github.com/${item.repo.name}`;
    case 'plan':
      return null;
    case 'task': {
      const { repository, prNumber, issueNumber } = item.task;
      if (!repository) return null;
      if (prNumber) return `https://github.com/${repository}/pull/${prNumber}`;
      if (issueNumber) return `https://github.com/${repository}/issues/${issueNumber}`;
      return null;
    }
  }
}

export function getItemTitle(item: SearchItem): string {
  switch (item.kind) {
    case 'repository':
      return item.repo.name;
    case 'plan':
      return item.plan.name || item.plan.initial_prompt;
    case 'task':
      return item.task.title || `Task ${item.task.id.slice(0, 8)}…`;
  }
}

export const formatTimeAgo = (dateString: string): string => {
  const diffMins = Math.floor((Date.now() - new Date(dateString).getTime()) / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h`;
  return `${Math.floor(diffHours / 24)}d`;
};

export const getRepoName = (repository: string): string => {
  const parts = repository.split('/');
  return parts.length > 1 ? parts[1] : repository;
};

/**
 * The body text a preview shows under its metadata: a plan's objective, a
 * task's subtitle. Null when there is none, or when it only restates the title
 * (the title itself, or `Plan <title>`), so the preview never prints the same
 * words twice. Any other description is kept, however short.
 */
export function getItemDescription(item: SearchItem): string | null {
  const description = item.kind === 'plan' ? item.plan.initial_prompt : item.kind === 'task' ? item.task.subtitle : null;
  if (!description?.trim()) return null;
  const words = (text: string) => (text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(' ');
  const title = words(getItemTitle(item));
  const body = words(description);
  const restatesTitle = description.trim() === getItemTitle(item).trim()
    || (title !== '' && (body === title || body === `plan ${title}`));
  return restatesTitle ? null : description.trim();
}

/** Splits a failure reason into prose and file paths, so paths can render as code. */
export function splitFailureReason(reason: string): Array<{ text: string; path: boolean }> {
  const pattern = /((?:[\w@.-]+\/)+[\w@-]+\.[A-Za-z0-9]+|\b[\w-]+\.(?:tsx?|jsx?|mjs|cjs|json|ya?ml|py|go|rs|rb|java|css|md)\b)/g;
  // A capturing split alternates prose (even indexes) and matched paths (odd indexes).
  return reason
    .split(pattern)
    .map((text, index) => ({ text, path: index % 2 === 1 }))
    .filter(part => part.text);
}

export type SearchStatusTone = 'failed' | 'active' | 'review' | 'pending' | 'merged' | 'cancelled' | 'done';

const STATUS_TONES: Record<string, SearchStatusTone> = {
  failed: 'failed',
  error: 'failed',
  running: 'active',
  processing: 'active',
  post_processing: 'active',
  claude_execution: 'active',
  implementing: 'active',
  generating: 'active',
  refining: 'active',
  executing: 'active',
  review: 'review',
  pr_created: 'review',
  pending: 'pending',
  queued: 'pending',
  waiting: 'pending',
  draft: 'pending',
  paused: 'pending',
  merged: 'merged',
  cancelled: 'cancelled',
};

/**
 * The standard status pill for a task or plan status: a dot plus a capitalised
 * label, coloured by the Studio logic (active work teal, a human bottleneck
 * amber, failure red, merged violet, finished work quiet gray).
 */
export function getSearchStatus(status: string): { label: string; tone: SearchStatusTone } {
  const words = status.replace(/_/g, ' ');
  const label = status === 'pr_created' ? 'PR created' : words.charAt(0).toUpperCase() + words.slice(1);
  return { label, tone: STATUS_TONES[status] ?? 'done' };
}
