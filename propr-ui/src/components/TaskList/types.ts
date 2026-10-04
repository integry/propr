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
}

export interface TaskGroup {
  key: string;
  repoOwner: string;
  repoName: string;
  prNumber?: number | null;
  tasks: Task[]; // Sorted newest first
}
