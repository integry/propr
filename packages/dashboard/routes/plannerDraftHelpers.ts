/**
 * Helper functions for draft operations in planner routes
 */

interface IssueSummary {
  total: number;
  pending: number;
  processing: number;
  merged: number;
  closed: number;
}

/**
 * Builds an issue summary map from issue records
 */
export function buildIssueSummaryMap(
  issues: Array<{ draft_id: string; status: string }>
): Record<string, IssueSummary> {
  const summaryMap: Record<string, IssueSummary> = {};

  for (const issue of issues) {
    if (!summaryMap[issue.draft_id]) {
      summaryMap[issue.draft_id] = { total: 0, pending: 0, processing: 0, merged: 0, closed: 0 };
    }
    summaryMap[issue.draft_id].total++;

    if (issue.status === 'pending') {
      summaryMap[issue.draft_id].pending++;
    } else if (
      issue.status === 'processing' ||
      issue.status === 'under_review' ||
      issue.status === 'in_refinement' ||
      issue.status === 'refinement_processing'
    ) {
      summaryMap[issue.draft_id].processing++;
    } else if (issue.status === 'merged') {
      summaryMap[issue.draft_id].merged++;
    } else if (issue.status === 'closed') {
      summaryMap[issue.draft_id].closed++;
    }
  }

  return summaryMap;
}

/**
 * Parses JSON string fields in a draft object
 */
export function parseDraftJsonFields(draft: Record<string, unknown>): Record<string, unknown> {
  const parsedDraft = { ...draft };

  if (typeof parsedDraft.plan_json === 'string') {
    try {
      parsedDraft.plan_json = JSON.parse(parsedDraft.plan_json);
    } catch {
      parsedDraft.plan_json = [];
    }
  }

  if (typeof parsedDraft.chat_history === 'string') {
    try {
      parsedDraft.chat_history = JSON.parse(parsedDraft.chat_history);
    } catch {
      parsedDraft.chat_history = [];
    }
  }

  if (typeof parsedDraft.context_config === 'string') {
    try {
      parsedDraft.context_config = JSON.parse(parsedDraft.context_config);
    } catch {
      parsedDraft.context_config = {};
    }
  }

  if (typeof parsedDraft.attachments === 'string') {
    try {
      parsedDraft.attachments = JSON.parse(parsedDraft.attachments);
    } catch {
      parsedDraft.attachments = [];
    }
  }

  if (typeof parsedDraft.generation_trace === 'string') {
    try {
      parsedDraft.generation_trace = JSON.parse(parsedDraft.generation_trace);
    } catch {
      parsedDraft.generation_trace = null;
    }
  }

  if (typeof parsedDraft.refinement_result === 'string') {
    try {
      parsedDraft.refinement_result = JSON.parse(parsedDraft.refinement_result);
    } catch {
      parsedDraft.refinement_result = null;
    }
  }

  return parsedDraft;
}

/**
 * Attaches issue summaries to draft objects
 */
export function attachIssueSummaries(
  drafts: Array<Record<string, unknown> & { draft_id: string }>,
  summaryMap: Record<string, IssueSummary | null>
): void {
  for (const draft of drafts) {
    (draft as { issue_summary?: IssueSummary | null }).issue_summary = summaryMap[draft.draft_id] || null;
  }
}
