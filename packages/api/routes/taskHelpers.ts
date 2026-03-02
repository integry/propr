import { Knex } from 'knex';

export interface TaskQuery {
  db: Knex;
  status: string;
  repository: string;
  limit: number;
  offset: number;
  search?: string;
  forReview?: boolean;
  excludeMerged?: boolean;
}

export async function getTasksFromDb(
  query: TaskQuery
): Promise<{ tasks: unknown[]; total: number; offset: number; limit: number }> {
  const { db, status, repository, limit, offset, search, forReview, excludeMerged } = query;
  const latestHistorySubquery = db('task_history')
    .select(
      'task_id',
      'state',
      'timestamp',
      'reason',
      db.raw('ROW_NUMBER() OVER(PARTITION BY task_id ORDER BY timestamp DESC) as rn')
    )
    .as('h');

  const processingStartSubquery = db('task_history')
    .select('task_id', db.raw('MIN(timestamp) as processing_start_timestamp'))
    .whereIn('state', ['processing', 'claude_execution', 'post_processing'])
    .groupBy('task_id')
    .as('ps');

  const completionSubquery = db('task_history')
    .select('task_id', db.raw('MIN(timestamp) as completion_timestamp'))
    .whereIn('state', ['completed', 'failed', 'cancelled'])
    .groupBy('task_id')
    .as('cs');

  const planIssueStatusSubquery = db('plan_issues')
    .select('task_id', 'status as plan_issue_status')
    .whereNotNull('task_id')
    .as('pi');

  const critiqueScoreSubquerySql = `
    LEFT JOIN (SELECT
      task_id,
      CASE
        WHEN json_valid(analysis_report) = 1
          AND json_extract(analysis_report, '$.report') IS NOT NULL
          AND INSTR(json_extract(analysis_report, '$.report'), '{') > 0
        THEN (
          SELECT
            CASE
              WHEN json_valid(clean_json) = 1
              THEN json_extract(clean_json, '$.implementation_critique_score')
              ELSE NULL
            END
          FROM (
            SELECT RTRIM(
              SUBSTR(
                json_extract(analysis_report, '$.report'),
                INSTR(json_extract(analysis_report, '$.report'), '{')
              ),
              CHAR(10) || CHAR(13) || ' ' || '\`'
            ) as clean_json
          )
        )
        ELSE NULL
      END as critique_score
    FROM llm_executions le1
    WHERE analysis_report IS NOT NULL
      AND json_valid(analysis_report) = 1
      AND json_extract(analysis_report, '$.report') IS NOT NULL
      AND execution_id = (
        SELECT MAX(le2.execution_id)
        FROM llm_executions le2
        WHERE le2.task_id = le1.task_id
          AND le2.analysis_report IS NOT NULL
          AND json_valid(le2.analysis_report) = 1
      )
    ) as cs_score ON cs_score.task_id = t.task_id
  `;

  const baseQuery = db('tasks as t')
    .join(latestHistorySubquery, function() {
      this.on('t.task_id', '=', 'h.task_id').andOn('h.rn', '=', db!.raw('?', [1]));
    })
    .leftJoin(processingStartSubquery, 'ps.task_id', 't.task_id')
    .leftJoin(completionSubquery, 'cs.task_id', 't.task_id')
    .leftJoin(planIssueStatusSubquery, 'pi.task_id', 't.task_id')
    .joinRaw(critiqueScoreSubquerySql);

  if (status && status !== 'all') {
    baseQuery.where('h.state', status);
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
    baseQuery.where(function() {
      this.whereNull('pi.plan_issue_status').orWhereNot('pi.plan_issue_status', 'merged');
    });
  }

  const totalResult = await baseQuery.clone().count('* as total').first();
  const total = parseInt(String(totalResult?.total || 0), 10);

  const dbTasks = await baseQuery
    .select('t.*', 'h.state', 'h.timestamp as state_timestamp', 'h.reason as failedReason',
            'ps.processing_start_timestamp', 'cs.completion_timestamp',
            'pi.plan_issue_status', 'cs_score.critique_score')
    .orderBy('t.created_at', 'desc')
    .limit(limit)
    .offset(offset);

  const tasks = dbTasks.map((row: Record<string, unknown>) => mapDbTaskToResponse(row));
  return { tasks, total, offset, limit };
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
    completedAt: row.completion_timestamp ? new Date(row.completion_timestamp as string).toISOString() : null,
    processedAt: row.processing_start_timestamp ? new Date(row.processing_start_timestamp as string).toISOString() : null,
    failedReason: row.state === 'failed' ? row.failedReason : null,
    progress: (row.state === 'completed' || row.state === 'failed' || row.state === 'cancelled') ? 100 : (row.state === 'processing' ? 50 : 0),
    attemptsMade: 1, modelName: row.model_name, model: row.model_name, llmProvider,
    planIssueStatus: row.plan_issue_status || null,
    critiqueScore: critiqueScore !== null && !isNaN(critiqueScore) ? critiqueScore : null
  };
}
