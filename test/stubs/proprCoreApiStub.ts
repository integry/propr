export const STOPPABLE_TASK_STATES = ['processing', 'claude_execution', 'post_processing'] as const;
export const TERMINAL_TASK_STATES = ['completed', 'failed', 'cancelled'] as const;
export const SUPPORTED_WEBHOOK_EVENTS = [
  'issues',
  'issue_comment',
  'pull_request_review_comment',
  'pull_request',
  'check_run',
  'status',
  'push',
] as const;

export const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export async function getActiveTasksForPR(): Promise<never[]> {
  return [];
}

export async function markPullRequestMerged(): Promise<void> {}

export async function stopDockerContainer() {
  return { success: true as const };
}

export function getStateManager() {
  return {
    markTaskCancelled: async () => {},
    getTaskState: async () => null,
  };
}

export async function getIssueQueue() {
  return {
    getJob: async () => null,
  };
}

export const db = Object.assign(() => ({
  select() {
    return this;
  },
  where() {
    return this;
  },
  whereNotNull() {
    return this;
  },
  first: async () => null,
}), {
  raw() {
    return 'raw';
  },
});

export function buildIssueRefFromQueueJob() {
  return null;
}

export function getPrNumberFromJobData() {
  return null;
}

export function getTaskIdFromQueueJob() {
  return null;
}

export function normalizeTaskId(taskId: string): string {
  return taskId;
}
