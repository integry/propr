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
 * Status text styling per the Studio colour logic: active work is teal, a human
 * bottleneck is an amber outline, failure is red, and finished work is quiet gray.
 */
export const getSearchStatusStyle = (status: string): string => {
  switch (status) {
    case 'failed':
    case 'error':
      return 'border border-red-200 text-red-600';
    case 'running':
    case 'processing':
    case 'generating':
    case 'refining':
    case 'executing':
      return 'border border-primary-500/40 text-primary-700';
    case 'review':
    case 'pending':
    case 'queued':
    case 'draft':
    case 'pr_created':
      return 'border border-amber-300 text-amber-700';
    default:
      return 'border border-transparent text-slate-500';
  }
};
