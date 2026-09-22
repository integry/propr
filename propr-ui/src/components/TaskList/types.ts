import type React from 'react';
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
  critiqueScore?: number | null;
}

export type TaskType = 'new-issue' | 'followup' | 'pr-workflow' | 'unknown';

export interface TaskTypeInfo {
  type: TaskType;
  cleanTitle: string;
  /** Workflow verb for PR-scoped tasks (Fix, Review, Follow-up, Ultrafix, Merge). */
  workflowLabel?: string;
  /** Pull request number parsed from a PR-scoped task title. */
  workflowPrNumber?: number;
}

export interface TaskListProps {
  limit: number;
  showViewAll?: boolean;
  hideFilters?: boolean;
  /** Rendered above the task table on the full Tasks page, scrolling with it. */
  leadingContent?: React.ReactNode;
}

export interface TaskGroup {
  key: string;
  repoOwner: string;
  repoName: string;
  prNumber?: number | null;
  tasks: Task[]; // Sorted newest first
}
