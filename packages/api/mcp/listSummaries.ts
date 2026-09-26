const SUMMARY_LIMIT = 240;
const TITLE_LIMIT = 160;
const RELATION_LIMIT = 8;
const RELATION_PAGE_BUDGET = RELATION_LIMIT * 20;
const MODEL_LIMIT = 100;

type JsonObject = Record<string, unknown>;

function parseObject(value: unknown): JsonObject {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as JsonObject;
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonObject : {};
  } catch {
    return {};
  }
}

function parseArray(value: unknown): JsonObject[] {
  if (Array.isArray(value)) return value.filter(item => item && typeof item === 'object') as JsonObject[];
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter(item => item && typeof item === 'object') as JsonObject[]
      : [];
  } catch {
    return [];
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function jsonTextBytes(value: string): number {
  // Budget serialized string content; surrounding quotes are fixed payload overhead.
  return Buffer.byteLength(JSON.stringify(value)) - 2;
}

export function compactText(value: unknown, limit = SUMMARY_LIMIT): string | null {
  const normalized = text(value)?.replace(/\s+/g, ' ') ?? null;
  if (!normalized || jsonTextBytes(normalized) <= limit) return normalized;
  const ellipsis = '…';
  const byteLimit = Math.max(0, limit - jsonTextBytes(ellipsis));
  let bytes = 0;
  let truncated = '';
  for (const character of normalized) {
    const characterBytes = jsonTextBytes(character);
    if (bytes + characterBytes > byteLimit) break;
    truncated += character;
    bytes += characterBytes;
  }
  return `${truncated.trimEnd()}${ellipsis}`;
}

export function planRelationLimit(pageSize: number): number {
  return Math.max(1, Math.min(RELATION_LIMIT, Math.floor(RELATION_PAGE_BUDGET / Math.max(1, pageSize))));
}

function positiveInteger(...values: unknown[]): number | null {
  for (const value of values) {
    const number = typeof value === 'number' ? value : Number(value);
    if (Number.isSafeInteger(number) && number > 0) return number;
  }
  return null;
}

function elapsedMilliseconds(start: unknown, end: unknown): number | null {
  const parseTimestamp = (value: unknown): number => {
    // Database timestamps without an offset are stored in UTC.
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)) {
      value = `${value.replace(' ', 'T')}Z`;
    }
    return new Date(value as string | number | Date).getTime();
  };
  const startMs = parseTimestamp(start);
  const endMs = parseTimestamp(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return Math.max(0, endMs - startMs);
}

function taskFallbackTitle(row: JsonObject, prNumber: number | null): string {
  const taskType = text(row.task_type)?.replace(/[-_]+/g, ' ') ?? 'task';
  const label = taskType.charAt(0).toUpperCase() + taskType.slice(1);
  if (prNumber && taskType === 'review') return `Review pull request #${prNumber}`;
  if (prNumber && taskType === 'pr comment') return `Pull request #${prNumber} comment task`;
  if (prNumber) return `${label} for pull request #${prNumber}`;
  const issueNumber = positiveInteger(row.issue_number);
  if (issueNumber && taskType === 'issue') return `Issue #${issueNumber}`;
  if (issueNumber) return `${label} for issue #${issueNumber}`;
  return `${label} ${String(row.task_id)}`;
}

function pullRequestState(planIssueStatus: unknown, hasPullRequest: boolean): string | null {
  if (!hasPullRequest) return null;
  if (planIssueStatus === 'merged' || planIssueStatus === 'closed') return planIssueStatus;
  return null;
}

export function summarizeTask(row: JsonObject, now = Date.now()): JsonObject {
  const job = parseObject(row.initial_job_data);
  const issueRef = parseObject(job.issueRef);
  const prNumber = positiveInteger(
    row.pr_number,
    row.plan_pr_number,
    job.pullRequestNumber,
    job.prNumber,
    issueRef.pullRequestNumber,
  );
  const rawTitle = text(job.title) ?? text(issueRef.title);
  const state = text(row.state) ?? 'pending';
  const stateMetadata = parseObject(row.state_metadata);
  const stateError = parseObject(stateMetadata.error);
  const updatedAt = row.updated_at ?? row.created_at ?? null;
  const startedAt = row.started_at ?? null;
  const completedAt = ['completed', 'failed', 'cancelled'].includes(state) ? updatedAt : null;
  const elapsedStart = startedAt ?? row.created_at;
  const elapsedEnd = completedAt ?? now;

  return {
    task_id: row.task_id,
    repository: row.repository,
    issue_number: row.issue_number ?? null,
    task_type: row.task_type,
    title: compactText(rawTitle ?? taskFallbackTitle(row, prNumber), TITLE_LIMIT),
    summary: compactText(job.subtitle),
    state,
    agent_alias: compactText(job.agentAlias ?? issueRef.agentAlias ?? row.plan_agent_alias, 100),
    model_name: compactText(row.model_name ?? job.modelName ?? issueRef.modelName ?? row.plan_model_name, MODEL_LIMIT),
    pr_number: prNumber,
    pr_state: pullRequestState(row.plan_issue_status, prNumber !== null && prNumber === positiveInteger(row.plan_pr_number)),
    created_at: row.created_at,
    updated_at: updatedAt,
    started_at: startedAt,
    completed_at: completedAt,
    elapsed_ms: elapsedMilliseconds(elapsedStart, elapsedEnd),
    failure_reason: state === 'failed'
      ? compactText(stateError.message ?? row.state_reason, 500)
      : null,
  };
}

export function summarizeGoal(row: JsonObject, now = Date.now()): JsonObject {
  const resultState = text(row.result_state);
  const state = resultState ?? text(row.desired_state) ?? 'running';
  const startedAt = row.started_at ?? null;
  const completedAt = row.completed_at ?? null;
  const elapsedStart = startedAt ?? row.created_at;
  const elapsedEnd = completedAt ?? now;
  const artifacts = parseArray(row.artifact_refs);
  const prNumber = positiveInteger(row.final_pr_number);
  const finalPr = artifacts.find(artifact => artifact.type === 'pull_request' && positiveInteger(artifact.number) === prNumber);
  const title = compactText(row.title, TITLE_LIMIT) ?? compactText(row.objective, TITLE_LIMIT) ?? 'Untitled goal';
  const summary = compactText(row.objective);

  return {
    goal_id: row.goal_id,
    repository: row.repository,
    title,
    summary: summary === title ? null : summary,
    state,
    desired_state: row.desired_state,
    result_state: row.result_state ?? null,
    current_task_id: row.current_task_id,
    agent_alias: compactText(row.agent_alias, 100),
    model_name: compactText(row.effective_model ?? row.requested_model, MODEL_LIMIT),
    pr_number: prNumber,
    pr_state: prNumber ? text(finalPr?.state) : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    started_at: startedAt,
    completed_at: completedAt,
    elapsed_ms: elapsedMilliseconds(elapsedStart, elapsedEnd),
    failure_reason: state === 'failed' ? compactText(row.failure_reason, 500) : null,
  };
}

function summarizePlanIssues(issues: JsonObject[]) {
  const counts = { total: issues.length, pending: 0, active: 0, merged: 0, closed: 0 };
  const agentModels = new Map<string, { agent_alias: string; model_name: string }>();
  const pullRequests = new Map<number, string | null>();
  for (const issue of issues) {
    const status = text(issue.status) ?? 'pending';
    if (status === 'pending') counts.pending += 1;
    else if (status === 'merged') counts.merged += 1;
    else if (status === 'closed') counts.closed += 1;
    else counts.active += 1;
    const alias = compactText(issue.agent_alias, 100);
    const model = compactText(issue.model_name, MODEL_LIMIT);
    if (alias && model) {
      const identity = JSON.stringify([issue.agent_alias, issue.model_name]);
      agentModels.set(identity, { agent_alias: alias, model_name: model });
    }
    const number = positiveInteger(issue.pr_number);
    if (number) pullRequests.set(number, pullRequestState(status, true));
  }
  return { counts, agentModels, pullRequests };
}

export function summarizePlan(row: JsonObject, issues: JsonObject[], now = Date.now(), relationLimit = RELATION_LIMIT): JsonObject {
  const { counts, agentModels, pullRequests } = summarizePlanIssues(issues);
  const status = text(row.status) ?? 'draft';
  const isTerminal = ['executed', 'merged', 'failed'].includes(status);
  const trace = parseObject(row.generation_trace);
  const refinement = parseObject(row.refinement_result);
  const context = parseObject(row.context_config);
  const generationModel = compactText(context.generationModel, MODEL_LIMIT);
  const onlyAgentModel = agentModels.size === 1 ? [...agentModels.values()][0] : null;
  const boundedRelationLimit = Math.max(0, Math.min(RELATION_LIMIT, relationLimit));

  return {
    draft_id: row.draft_id,
    repository: row.repository,
    title: compactText(row.name, TITLE_LIMIT) ?? 'Untitled plan',
    summary: compactText(row.initial_prompt),
    status,
    paused: Boolean(row.paused),
    mcp_revision: row.mcp_revision,
    issue_counts: counts,
    agent_alias: onlyAgentModel?.agent_alias ?? null,
    model_name: onlyAgentModel?.model_name ?? generationModel,
    generation_model: generationModel,
    agent_model_count: agentModels.size,
    agent_models: [...agentModels.values()].slice(0, boundedRelationLimit),
    pull_request_count: pullRequests.size,
    pull_requests: [...pullRequests].slice(0, boundedRelationLimit).map(([number, state]) => ({ number, state })),
    created_at: row.created_at,
    updated_at: row.updated_at,
    started_at: row.created_at,
    // Plans do not persist a completion timestamp; updated_at can change after completion.
    completed_at: null,
    elapsed_ms: isTerminal ? null : elapsedMilliseconds(row.created_at, now),
    failure_reason: status === 'failed'
      ? compactText(trace.error ?? refinement.error, 500)
      : null,
  };
}

export function summarizeTodo(row: JsonObject): JsonObject {
  const linkedPlanId = text(row.linked_draft_id);
  const title = compactText(row.content, TITLE_LIMIT) ?? 'Untitled TODO';
  const summary = compactText(row.content);
  return {
    todo_id: row.todo_id,
    repository: row.repository,
    title,
    summary: summary === title ? null : summary,
    is_completed: Boolean(row.is_completed),
    category: row.category_id ? { id: row.category_id, name: compactText(row.category_name, 100) } : null,
    linked_plan: linkedPlanId ? {
      id: linkedPlanId,
      title: compactText(row.linked_plan_name, TITLE_LIMIT),
      status: row.linked_plan_status ?? null,
    } : null,
    order_index: row.order_index,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
