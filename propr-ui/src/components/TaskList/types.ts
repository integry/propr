import type { PublishedVisualPreview } from '@propr/shared';
export interface Task {
  previewMedia?: PublishedVisualPreview[];
  id: string;
  repository?: string;
  repositoryOwner?: string | null;
  repositoryName?: string | null;
  issueNumber?: number;
  prNumber?: number | null;
  linkedIssueNumber?: number | null;
  title?: string | null;
  subtitle?: string | null;
  status: string;
  createdAt: string;
  processedAt?: string | null;
  completedAt?: string | null;
  modelName?: string | null;
  model?: string | null;
  llmProvider?: string | null;
  planIssueStatus?: string | null;
  failedReason?: string | null;
  commitHash?: string | null;
}

export interface TaskListProps {
  limit: number;
  showViewAll?: boolean;
  hideFilters?: boolean;
  /** The task open beside the list; its row is marked selected. */
  selectedTaskId?: string | null;
  /**
   * Opens a task beside the list instead of navigating to it. When set, a
   * plain click on a row selects it, and while a task is selected j/k and the
   * arrow keys step through the rows of the page.
   */
  onSelectTask?: (taskId: string) => void;
  /** Changing it reloads the page of tasks in place, e.g. after a task is deleted beside the list. */
  refreshKey?: number;
}

export interface TaskGroup {
  key: string;
  repoOwner: string;
  repoName: string;
  prNumber?: number | null;
  tasks: Task[]; // Sorted newest first
}
