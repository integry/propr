import { latestCommentMetadata, previewMediaReader, taskPreviewSource } from '../services/previewMediaProjection.js';
import { Knex } from 'knex';
import { timeApiStage } from '../apiPerformanceTiming.js';
import { QUEUED_TASK_STATES, RUNNING_TASK_STATES } from './dashboardQueries.js';
import { loadAttentionTaskIds } from './dashboardWorkQueries.js';
import { loadCritiqueScores } from './critiqueScore.js';

export interface TaskQuery {
  db: Knex;
  previewReader?: typeof previewMediaReader;
  status: string;
  repository: string;
  limit: number;
  offset: number;
  search?: string;
  forReview?: boolean;
  excludeMerged?: boolean;
}

// The UI labels in-progress work "Active"/"Implementing" and queued work
// "Waiting", but task_history only ever stores canonical worker lifecycle
// states. Filtering on the label directly matched no rows, so map each label
// onto the worker states it represents. The dashboard counts the same states,
// so both read one definition.
const ACTIVE_WORKER_STATES = [...RUNNING_TASK_STATES];
const WAITING_WORKER_STATES = [...QUEUED_TASK_STATES];

/**
 * The attention filter is not a state list.
 *
 * "Needs attention" is a judgement, not a lifecycle state: a failure the
 * system is already retrying is not attention, and a completed run whose pull
 * request is waiting on a review decision is. Matching states here produced a
 * list that disagreed with the count that opens it in both directions, so the
 * filter asks the dashboard projection which tasks those are instead.
 */
const ATTENTION_STATUS = 'attention';

const normalizeStatus = (status: string): string => status.trim().toLowerCase();

function resolveStatusStates(status: string): string[] | null {
  switch (normalizeStatus(status)) {
    case 'active':
    case 'implementing':
      return ACTIVE_WORKER_STATES;
    case 'waiting':
    case 'pending':
      return WAITING_WORKER_STATES;
    default:
      return null;
  }
}

export async function getTasksFromDb(
  query: TaskQuery
): Promise<{ tasks: unknown[]; total: number; offset: number; limit: number }> {
  const { db, status, repository, limit, offset, search, forReview, excludeMerged } = query;
  // Resolve one history row per task with an indexed lookup. The former global
  // ROW_NUMBER window materialized and sorted all task_history rows for every
  // count and page request. timestamp remains the sole ordering key so equal
  // timestamps retain SQLite's existing index/rowid tie behaviour.
  const baseQuery = db('tasks as t')
    .where(function() {
      this.whereNull('t.task_type').orWhereNot('t.task_type', 'goal');
    })
    .joinRaw(`
      JOIN task_history AS h ON h.history_id = (
        SELECT latest_h.history_id
        FROM task_history AS latest_h
        WHERE latest_h.task_id = t.task_id
        ORDER BY latest_h.timestamp DESC
        LIMIT 1
      )
    `);

  if (normalizeStatus(status) === ATTENTION_STATUS) {
    // Exactly the work the dashboard's attention count describes, including
    // plan reviews awaiting a decision and the runs behind decisions that
    // recorded no task link, and excluding failures under recovery.
    const attentionTaskIds = await timeApiStage('sql.tasks.attention', () =>
      loadAttentionTaskIds(db, repository));
    if (attentionTaskIds.length === 0) return { tasks: [], total: 0, offset, limit };
    baseQuery.whereIn('t.task_id', attentionTaskIds);
  } else if (status && status !== 'all') {
    const lifecycleStates = resolveStatusStates(status);
    if (lifecycleStates) {
      baseQuery.whereIn('h.state', lifecycleStates);
    } else {
      baseQuery.where('h.state', status);
    }
  }
  if (repository && repository !== 'all') {
    baseQuery.where('t.repository', repository);
  }
  if (search && search.trim() !== '') {
    const searchTerm = `%${search.trim()}%`;
    baseQuery.where(function() {
      this.where('t.repository', 'like', searchTerm)
        .orWhere(db.raw('CAST(t.issue_number AS TEXT)'), 'like', searchTerm)
        .orWhere('t.initial_job_data', 'like', searchTerm);
    });
  }
  if (forReview) {
    baseQuery.whereIn('h.state', ['completed', 'failed']);
  }
  if (excludeMerged) {
    // A task was included by the previous left join whenever it had no linked
    // plan issue or at least one non-merged link. Express that as EXISTS so
    // multiple plan_issues cannot duplicate task identities or inflate total.
    baseQuery.where(function() {
      this.whereNotExists(
        db('plan_issues as pi_any')
          .select(db.raw('1'))
          .whereRaw('pi_any.task_id = t.task_id')
      ).orWhereExists(
        db('plan_issues as pi_open')
          .select(db.raw('1'))
          .whereRaw('pi_open.task_id = t.task_id')
          .whereNot('pi_open.status', 'merged')
      );
    });
  }

  // Count only the filtered task identity/state set. Processing timestamps,
  // completion timestamps and critique JSON are presentation enrichments and
  // previously made the count repeat all three full-history joins.
  const totalResult = await timeApiStage('sql.tasks.count', () =>
    baseQuery.clone().count('* as total').first()
  );
  const total = parseInt(String(totalResult?.total || 0), 10);

  // Apply ordering and pagination before presentation enrichment. This bounds
  // aggregate and JSON work by the requested page rather than database size.
  const pageTasks = await timeApiStage('sql.tasks.page', () => baseQuery
    .select('t.*', 'h.state', 'h.timestamp as state_timestamp', 'h.reason as failedReason')
    .orderBy('t.created_at', 'desc')
    .limit(limit)
    .offset(offset));

  if (pageTasks.length === 0) return { tasks: [], total, offset, limit };

  const taskIds = pageTasks.map((row: Record<string, unknown>) => String(row.task_id));
  const { historyByTask, planStatusByTask, critiqueScoreByTask, commentMetadataByTask } = await timeApiStage(
    'sql.tasks.enrichment',
    async () => enrichTaskPage(db, taskIds, Boolean(excludeMerged))
  );

  // Completion comments stay with their run even when later entries (e.g. cleanup) carry no metadata.
  const media = await (query.previewReader ?? previewMediaReader).project(pageTasks.map((row: Record<string, unknown>) =>
    taskPreviewSource({ ...row, latest_metadata: commentMetadataByTask.get(String(row.task_id)) })), 3);
  const tasks = pageTasks.map((row: Record<string, unknown>, index: number) => ({
    ...mapDbTaskToResponse({
      ...row,
      ...historyByTask.get(String(row.task_id)),
      plan_issue_status: planStatusByTask.get(String(row.task_id)) ?? null,
      critique_score: critiqueScoreByTask.get(String(row.task_id)) ?? null,
    }),
    ...(media[index].previews.length ? { previewMedia: media[index].previews } : {}),
  }));
  return { tasks, total, offset, limit };
}

interface TaskPageEnrichment {
  historyByTask: Map<string, Record<string, unknown>>;
  planStatusByTask: Map<string, unknown>;
  critiqueScoreByTask: Map<string, unknown>;
  commentMetadataByTask: Map<string, unknown>;
}

async function enrichTaskPage(db: Knex, taskIds: string[], excludeMerged: boolean): Promise<TaskPageEnrichment> {
  const historyRows = await db('task_history')
    .whereIn('task_id', taskIds)
    .select(
      'task_id',
      db.raw(`MIN(CASE
        WHEN state IN ('processing', 'claude_execution', 'post_processing') THEN timestamp
      END) AS processing_start_timestamp`),
      db.raw(`MIN(CASE
        WHEN state IN ('completed', 'failed', 'cancelled') THEN timestamp
      END) AS completion_timestamp`)
    )
    .groupBy('task_id');

  const planIssueQuery = db('plan_issues')
    .whereIn('task_id', taskIds)
    .whereNotNull('task_id')
    .select('task_id', 'status')
    .orderBy('task_id', 'asc')
    .orderBy('id', 'asc');
  if (excludeMerged) planIssueQuery.whereNot('status', 'merged');
  const planIssueRows = await planIssueQuery;

  // Only executions belonging to this page are read, newest first, so the
  // "latest valid outer analysis report" choice never evaluates JSON for
  // unrelated tasks.
  const critiqueScoreByTask = await loadCritiqueScores(db, taskIds);

  // Only rows that may carry a completion comment are read; the helper confirms the parsed shape.
  const commentRows = await db('task_history')
    .whereIn('task_id', taskIds)
    .where('metadata', 'like', '%githubComment%')
    .select('task_id', 'metadata')
    .orderBy('timestamp', 'asc')
    .orderBy('history_id', 'asc');
  const commentMetadataByTask = new Map<string, unknown>();
  for (const row of commentRows as Array<Record<string, unknown>>) {
    const metadata = latestCommentMetadata([row]);
    if (metadata !== undefined) commentMetadataByTask.set(String(row.task_id), metadata);
  }

  const historyByTask = new Map<string, Record<string, unknown>>();
  for (const row of historyRows as Array<Record<string, unknown>>) {
    historyByTask.set(String(row.task_id), row);
  }

  const planStatusByTask = new Map<string, unknown>();
  for (const row of planIssueRows as Array<Record<string, unknown>>) {
    const taskId = String(row.task_id);
    if (!planStatusByTask.has(taskId)) planStatusByTask.set(taskId, row.status);
  }

  return { historyByTask, planStatusByTask, critiqueScoreByTask, commentMetadataByTask };
}

function parseRepositoryParts(repository: unknown): { owner: string | null; name: string | null } {
  if (repository && typeof repository === 'string') {
    const parts = repository.split('/');
    if (parts.length === 2) return { owner: parts[0], name: parts[1] };
  }
  return { owner: null, name: null };
}

function parseInitialJobData(row: Record<string, unknown>): {
  title: string | null; subtitle: string | null; llmProvider: string | null;
  prNumber: number | null; issueNumber: number | null;
} {
  const result = { title: null as string | null, subtitle: null as string | null, llmProvider: null as string | null, prNumber: null as number | null, issueNumber: null as number | null };
  if (!row.initial_job_data) return result;
  try {
    const jobData = typeof row.initial_job_data === 'string' ? JSON.parse(row.initial_job_data) : row.initial_job_data;
    result.title = jobData.title || (jobData.issueRef ? jobData.issueRef.title : null) || null;
    result.subtitle = jobData.subtitle || null;
    result.llmProvider = jobData.agentAlias || null;
    if (jobData.pullRequestNumber) result.prNumber = jobData.pullRequestNumber;
    if (jobData.issueNumber) result.issueNumber = jobData.issueNumber;
  } catch (e) {
    console.error('Failed to parse initial_job_data', e);
  }
  return result;
}

function extractPrNumberFromFinalResult(row: Record<string, unknown>): number | null {
  if (!row.final_result) return null;
  try {
    const finalResult = typeof row.final_result === 'string' ? JSON.parse(row.final_result) : row.final_result;
    return finalResult?.postProcessing?.pr?.number || null;
  } catch {
    return null;
  }
}

function mapDbTaskToResponse(row: Record<string, unknown>): Record<string, unknown> {
  const { owner: repositoryOwner, name: repositoryName } = parseRepositoryParts(row.repository);
  const { title, subtitle, llmProvider, prNumber: jobDataPrNumber, issueNumber: jobDataIssueNumber } = parseInitialJobData(row);
  const prNumber = (row.pr_number as number | null) || jobDataPrNumber || extractPrNumberFromFinalResult(row);
  const linkedIssueNumber = jobDataIssueNumber;
  const critiqueScore = row.critique_score !== null && row.critique_score !== undefined
    ? typeof row.critique_score === 'number' ? row.critique_score : parseFloat(row.critique_score as string)
    : null;

  return {
    id: row.task_id, issueId: row.task_id, repository: row.repository,
    repositoryOwner, repositoryName, issueNumber: row.issue_number,
    prNumber, linkedIssueNumber, title, subtitle, status: row.state,
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.state_timestamp as string).toISOString(),
    completedAt: row.completion_timestamp ? new Date(row.completion_timestamp as string).toISOString() : null,
    processedAt: row.processing_start_timestamp ? new Date(row.processing_start_timestamp as string).toISOString() : null,
    failedReason: row.state === 'failed' ? row.failedReason : null,
    progress: (row.state === 'completed' || row.state === 'failed' || row.state === 'cancelled') ? 100 : (row.state === 'processing' ? 50 : 0),
    attemptsMade: 1, modelName: row.model_name, model: row.model_name, llmProvider,
    planIssueStatus: row.plan_issue_status || null,
    critiqueScore: critiqueScore !== null && !isNaN(critiqueScore) ? critiqueScore : null
  };
}
