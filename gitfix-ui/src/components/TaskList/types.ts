export interface Task {
  id: string;
  repository?: string;
  repositoryOwner?: string;
  repositoryName?: string;
  issueNumber?: number;
  prNumber?: number;
  title?: string;
  subtitle?: string;
  status: string;
  createdAt: string;
  processedAt?: string;
  completedAt?: string;
  modelName?: string;
  model?: string;
  llmProvider?: string;
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
  prNumber?: number;
  tasks: Task[]; // Sorted newest first
}
