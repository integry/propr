import type { LiveQueueJob, SystemAgentStatus, SystemStatus } from '../api/proprTypes';
import type { DraftListItem } from '../api/plannerApi';

export const DISMISSED_PLAN_IDS_KEY = 'dismissed_plan_ids';
export const DISMISSED_TASK_IDS_KEY = 'dismissed_task_ids';
const DISMISSED_TASK_TIMESTAMPS_KEY = 'dismissed_task_timestamps';

interface Task {
  id: string;
  repository?: string;
  repositoryOwner?: string;
  repositoryName?: string;
  issueNumber?: number;
  prNumber?: number;
  linkedIssueNumber?: number | null;
  title?: string;
  status: string;
  createdAt: string;
  completedAt?: string;
  planIssueStatus?: string | null;
}

export interface RunningItem {
  id: string;
  navigationId?: string;
  type: 'plan' | 'task';
  label: string;
  repository: string;
  status: string;
  createdAt: string;
}

export interface DismissedTaskTimestamps {
  [key: string]: number;
}

export interface TaskGroup {
  key: string;
  repoOwner: string;
  repoName: string;
  prNumber?: number;
  issueNumber?: number;
  latestTask: Task;
  allTasks: Task[];
}

export interface SystemHealth {
  daemon: string;
  workers: string;
  redis: string;
  githubAuth: string;
  claudeAuth: string;
  indexing: string;
  githubEventIntake: string;
  githubEventIntakeStatus: string;
  agents: SystemAgentStatus[];
  isHealthy: boolean;
}

export function getDismissedIds(key: string): string[] {
  try {
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

export function saveDismissedIds(key: string, ids: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(ids));
  } catch {
    console.error(`Failed to save dismissed IDs to ${key}`);
  }
}

export function getDismissedTaskTimestamps(): DismissedTaskTimestamps {
  try {
    const stored = localStorage.getItem(DISMISSED_TASK_TIMESTAMPS_KEY);
    return stored ? JSON.parse(stored) : {};
  } catch {
    return {};
  }
}

export function saveDismissedTaskTimestamps(timestamps: DismissedTaskTimestamps): void {
  try {
    localStorage.setItem(DISMISSED_TASK_TIMESTAMPS_KEY, JSON.stringify(timestamps));
  } catch {
    console.error('Failed to save dismissed task timestamps');
  }
}

function getTaskGroupKey(
  repoOwner: string,
  repoName: string,
  prNumber?: number,
  issueNumber?: number
): string {
  const repoPrefix = `${repoOwner}/${repoName}`;
  if (prNumber) return `${repoPrefix}-pr-${prNumber}`;
  if (issueNumber) return `${repoPrefix}-issue-${issueNumber}`;
  return '';
}

export function buildRunningItems(
  drafts: DraftListItem[],
  activeJobs: LiveQueueJob[]
): RunningItem[] {
  const runningItems: RunningItem[] = drafts
    .filter(draft => draft.status === 'generating' || draft.status === 'refining')
    .map(plan => ({
      id: plan.draft_id,
      type: 'plan' as const,
      label: plan.name || plan.initial_prompt || 'Generating Plan',
      repository: plan.repository,
      status: plan.status === 'generating' ? 'Generating Spec' : 'Refining',
      createdAt: plan.created_at,
    }));

  runningItems.push(...activeJobs.map(job => ({
    id: job.id,
    ...(job.taskId ? { navigationId: job.taskId } : {}),
    type: 'task' as const,
    label: job.title || `Task ${job.id.slice(0, 8)}`,
    repository: job.repository,
    status: 'Implementing',
    createdAt: job.createdAt,
  })));

  return runningItems.sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

export function filterActivePlans(drafts: DraftListItem[]): DraftListItem[] {
  const dismissedPlanIds = getDismissedIds(DISMISSED_PLAN_IDS_KEY);
  return drafts
    .filter(draft => !dismissedPlanIds.includes(draft.draft_id))
    .sort((a, b) =>
      new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
    );
}

function getTaskRepository(task: Task): { owner: string; name: string } {
  if (task.repositoryOwner && task.repositoryName) {
    return { owner: task.repositoryOwner, name: task.repositoryName };
  }
  const parts = (task.repository || 'unknown/unknown').split('/');
  return {
    owner: parts[0] || 'unknown',
    name: parts[1] || 'unknown',
  };
}

function indexPrTasksByIssue(tasks: Task[]): Record<string, boolean> {
  const prTasksByIssue: Record<string, boolean> = {};
  tasks.forEach(task => {
    if (!task.prNumber || !task.issueNumber) return;
    const { owner, name } = getTaskRepository(task);
    prTasksByIssue[`${owner}/${name}-issue-${task.issueNumber}`] = true;
  });
  return prTasksByIssue;
}

interface ReviewGroupingContext {
  groups: Record<string, TaskGroup>;
  issueToPrMap: Record<string, string>;
  prTasksByIssue: Record<string, boolean>;
  dismissedTaskIds: string[];
  dismissedTimestamps: DismissedTaskTimestamps;
}

function addReviewTask(task: Task, context: ReviewGroupingContext): void {
  const { owner, name } = getTaskRepository(task);
  const repoPrefix = `${owner}/${name}`;
  const key = getTaskGroupKey(owner, name, task.prNumber, task.issueNumber) || task.id;
  const dismissedTimestamp = context.dismissedTimestamps[key];

  if (dismissedTimestamp && new Date(task.createdAt).getTime() <= dismissedTimestamp) return;
  if (context.dismissedTaskIds.includes(task.id)) return;

  if (task.prNumber && task.linkedIssueNumber) {
    context.issueToPrMap[`${repoPrefix}-issue-${task.linkedIssueNumber}`] =
      `${repoPrefix}-pr-${task.prNumber}`;
  }
  if (!task.prNumber && task.issueNumber && context.prTasksByIssue[key]) return;

  if (!context.groups[key]) {
    context.groups[key] = {
      key,
      repoOwner: owner,
      repoName: name,
      prNumber: task.prNumber,
      issueNumber: task.issueNumber,
      latestTask: task,
      allTasks: [],
    };
  }
  context.groups[key].allTasks.push(task);
}

function mergeIssueGroups(
  groups: Record<string, TaskGroup>,
  issueToPrMap: Record<string, string>
): void {
  Object.entries(issueToPrMap).forEach(([issueKey, prKey]) => {
    if (!groups[issueKey] || !groups[prKey]) return;
    groups[prKey].allTasks.push(...groups[issueKey].allTasks);
    delete groups[issueKey];
  });
}

export function buildReviewGroups(tasksResponse: unknown): TaskGroup[] {
  const tasks = (tasksResponse as { tasks: Task[] }).tasks || [];
  const context: ReviewGroupingContext = {
    groups: {},
    issueToPrMap: {},
    prTasksByIssue: indexPrTasksByIssue(tasks),
    dismissedTaskIds: getDismissedIds(DISMISSED_TASK_IDS_KEY),
    dismissedTimestamps: getDismissedTaskTimestamps(),
  };

  tasks.forEach(task => addReviewTask(task, context));
  mergeIssueGroups(context.groups, context.issueToPrMap);

  return Object.values(context.groups)
    .map(group => {
      group.allTasks.sort((a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      group.latestTask = group.allTasks[0];
      return group;
    })
    .sort((a, b) =>
      new Date(b.latestTask.createdAt).getTime() - new Date(a.latestTask.createdAt).getTime()
    );
}

export function buildSystemHealth(status: SystemStatus): SystemHealth {
  const workers = status.workers.length > 0 ? 'Running' : 'Stopped';
  const agentsHealthy = status.agents.every(agent => agent.status === 'Ready');
  const intakeStatus = status.githubEventIntakeStatus || 'Unknown';
  return {
    daemon: status.daemon,
    workers,
    redis: status.redis,
    githubAuth: status.githubAuth,
    claudeAuth: status.claudeAuth,
    indexing: status.indexing,
    githubEventIntake: status.githubEventIntake || 'Unknown',
    githubEventIntakeStatus: intakeStatus,
    agents: status.agents,
    isHealthy:
      status.daemon === 'Running' &&
      workers === 'Running' &&
      status.redis === 'Connected' &&
      status.githubAuth === 'Authenticated' &&
      ['Idle', 'Active', 'Queued', 'Connected'].includes(status.indexing) &&
      ['Connected', 'Active', 'Unknown'].includes(intakeStatus) &&
      agentsHealthy,
  };
}
