/**
 * Pure display-logic helpers for LLM log work references.
 * No browser or React dependencies — safe to import from Node.js tests.
 */

export interface WorkRefFields {
  workType: 'task' | 'plan' | 'repository' | null;
  taskId: string | null;
  taskNumber: number | null;
  prNumber: number | null;
  planDraftId: string | null;
  planIssueId: number | null;
  workRepository: string | null;
  repository: string | null;
  metadata: Record<string, unknown> | null;
  draftId: string | null;
  sessionId: string | null;
  correlationId: string | null;
  errorMessage: string | null;
}

// Get a human-readable work reference summary for a log entry
export const getWorkReferenceDisplay = (log: WorkRefFields): string => {
  if (!log.workType) return '-';

  const parts: string[] = [];
  const repo = log.workRepository || log.repository || '';

  if (log.workType === 'task') {
    if (log.taskNumber) {
      parts.push(`Issue #${log.taskNumber}`);
    }
    if (log.prNumber) {
      parts.push(`PR #${log.prNumber}`);
    }
    if (parts.length === 0 && log.taskId) {
      parts.push(`Task ${log.taskId.substring(0, 8)}`);
    }
    // Fallback: use draftId if available (links to the plan/draft this task belongs to)
    if (parts.length === 0 && log.draftId) {
      parts.push(`Draft ${log.draftId.substring(0, 8)}`);
    }
  } else if (log.workType === 'plan') {
    if (log.planIssueId) {
      parts.push(`Plan Issue #${log.planIssueId}`);
    } else if (log.planDraftId) {
      parts.push(`Draft ${log.planDraftId.substring(0, 8)}`);
    }
    // Fallback: use draftId if planDraftId isn't set
    if (parts.length === 0 && log.draftId) {
      parts.push(`Draft ${log.draftId.substring(0, 8)}`);
    }
  } else if (log.workType === 'repository') {
    if (repo) {
      return repo;
    }
    return 'Repository analysis';
  }

  if (parts.length === 0) {
    // No specific identifiers but we know the work type — show repository if available
    return repo || '-';
  }
  if (repo && log.workType !== 'repository') {
    return `${repo} · ${parts.join(', ')}`;
  }
  return parts.join(', ');
};

// Get a label for the work type
export const getWorkTypeLabel = (workType: string | null): string => {
  switch (workType) {
    case 'task': return 'Task';
    case 'plan': return 'Plan';
    case 'repository': return 'Repo';
    default: return '-';
  }
};

// Check if a log has detailed info to show
export const hasDetailedInfo = (log: WorkRefFields): boolean => {
  return !!(log.metadata || log.draftId || log.sessionId || log.correlationId || log.errorMessage || log.workType);
};
