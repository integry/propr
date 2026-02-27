import type { Task, TaskGroup } from './types';

/** Checks if a URL param value should be treated as empty/default and removed */
export function isDefaultParamValue(value: string | null): boolean {
  return value === null || value === 'all' || value === '' || value === '1';
}

/** Returns the URL value or local value based on whether URL state is used */
export function selectValue<T>(useUrlState: boolean, urlValue: T, localValue: T): T {
  return useUrlState ? urlValue : localValue;
}

/** Creates a filter setter that either updates URL params or local state */
export function createFilterSetter(
  useUrlState: boolean,
  urlUpdater: (value: string) => void,
  localStateSetter: (value: string) => void,
  resetPage: () => void
) {
  return (newValue: string) => {
    if (useUrlState) {
      urlUpdater(newValue);
    } else {
      localStateSetter(newValue);
      resetPage();
    }
  };
}

/** Creates a toggle handler for expanding/collapsing task groups */
export function createToggleGroupHandler(setExpandedGroups: React.Dispatch<React.SetStateAction<Set<string>>>) {
  return (groupKey: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.add(groupKey);
      }
      return next;
    });
  };
}

/**
 * Groups tasks by PR number, issue number, or task ID for display.
 * Merges issue-based groups into PR-based groups when linked.
 */
export function groupTasksForDisplay(tasks: Task[]): TaskGroup[] {
  const groups: Record<string, TaskGroup> = {};
  const issueToPrMap: Record<string, string> = {};

  // First pass: create initial groups and build issue-to-PR mapping
  tasks.forEach(task => {
    let owner = task.repositoryOwner;
    let name = task.repositoryName;

    if (!owner || !name) {
      const parts = (task.repository || 'unknown/unknown').split('/');
      owner = parts[0] || 'unknown';
      name = parts[1] || 'unknown';
    }

    const repoPrefix = `${owner}/${name}`;

    if (task.prNumber && task.linkedIssueNumber) {
      const issueKey = `${repoPrefix}-issue-${task.linkedIssueNumber}`;
      const prKey = `${repoPrefix}-pr-${task.prNumber}`;
      issueToPrMap[issueKey] = prKey;
    }

    let key: string;
    if (task.prNumber) {
      key = `${repoPrefix}-pr-${task.prNumber}`;
    } else if (task.issueNumber) {
      key = `${repoPrefix}-issue-${task.issueNumber}`;
    } else {
      key = task.id;
    }

    if (!groups[key]) {
      groups[key] = {
        key,
        repoOwner: owner,
        repoName: name,
        prNumber: task.prNumber,
        tasks: []
      };
    }
    groups[key].tasks.push(task);
  });

  // Second pass: merge issue-based groups into their corresponding PR groups
  Object.entries(issueToPrMap).forEach(([issueKey, prKey]) => {
    if (groups[issueKey] && groups[prKey]) {
      groups[prKey].tasks.push(...groups[issueKey].tasks);
      delete groups[issueKey];
    }
  });

  // Sort tasks within each group by creation date (newest first)
  Object.values(groups).forEach(group => {
    group.tasks.sort((a, b) => {
      const dateA = new Date(a.createdAt).getTime();
      const dateB = new Date(b.createdAt).getTime();
      return dateB - dateA;
    });
  });

  return Object.values(groups).sort((a, b) => {
    const dateA = new Date(a.tasks[0].createdAt).getTime();
    const dateB = new Date(b.tasks[0].createdAt).getTime();
    return dateB - dateA;
  });
}
