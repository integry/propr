export interface Task {
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
  critiqueScore?: number | null;
}

export type TaskType = 'new-issue' | 'followup' | 'unknown';

export interface TaskTypeInfo {
  type: TaskType;
  cleanTitle: string;
}

export interface TaskListProps {
  limit: number;
  showViewAll?: boolean;
  hideFilters?: boolean;
}

export interface LoadConfig {
  setLoadingState?: boolean;
}

export interface TaskGroup {
  key: string;
  repoOwner: string;
  repoName: string;
  prNumber?: number | null;
  tasks: Task[]; // Sorted newest first
}
