// Seeds the token-outlier baseline from executions recorded before
// `llm_execution_token_samples` existed, so an instance that already has
// history alerts on the first outlier after the upgrade instead of waiting for
// eight new runs per repository, model and execution type.
//
// Only successful executions whose baseline key can be attributed are copied,
// keyed exactly as `recordLLMMetrics` keys a new sample:
// - repository: the execution's task (lowercased); a task-less run has none;
// - model: the execution's own `model_name`;
// - execution type: read from the `llm_logs` call of the same run (same task
//   and agent session). A call logged with an explicit type (`pr-review`,
//   `context-analysis`, ...) was recorded with that type. A task run's call
//   (`implementation`) was recorded with its job type, named by the task's
//   type (`issue`/`goal` run as `issue`, `pr-comment` as `pr_comment`,
//   `merge_conflict` as `merge_conflict`); any other task type is skipped.
//   An execution without such a call, or whose calls disagree, is skipped.
// - total tokens: `input_tokens` (which already includes cache reads and
//   writes) plus `output_tokens`; an execution without both is skipped.
//
// Each key keeps at most its last 200 executions, the largest baseline window
// the setting allows. Rows already sampled are left as they are.
const SAMPLES = 'llm_execution_token_samples';
const MAX_BASELINE_RUNS = 200;

const JOB_TYPE_BY_TASK_TYPE = `CASE t.task_type
  WHEN 'issue' THEN 'issue'
  WHEN 'goal' THEN 'issue'
  WHEN 'pr-comment' THEN 'pr_comment'
  WHEN 'merge_conflict' THEN 'merge_conflict'
END`;

async function attributable(knex) {
  const tables = await Promise.all([SAMPLES, 'llm_executions', 'tasks', 'llm_logs'].map(name => knex.schema.hasTable(name)));
  if (tables.includes(false)) return false;
  const columns = await Promise.all([
    knex.schema.hasColumn('llm_logs', 'task_id'),
    knex.schema.hasColumn('llm_logs', 'session_id'),
    knex.schema.hasColumn('llm_executions', 'input_tokens'),
    knex.schema.hasColumn('llm_executions', 'output_tokens'),
  ]);
  return !columns.includes(false);
}

export async function up(knex) {
  if (!await attributable(knex)) return;
  await knex.raw(`
    INSERT INTO ${SAMPLES} (execution_id, task_id, repository, model_name, execution_type, success, total_tokens, recorded_at)
    SELECT execution_id, task_id, repository, model_name, execution_type, ?, total_tokens, recorded_at
    FROM (
      SELECT attributed.*, row_number() OVER (
        PARTITION BY repository, model_name, execution_type ORDER BY execution_id DESC
      ) AS recency
      FROM (
        SELECT e.execution_id,
          min(e.task_id) AS task_id,
          min(lower(trim(t.repository))) AS repository,
          min(e.model_name) AS model_name,
          min(run.execution_type) AS execution_type,
          min(e.input_tokens + e.output_tokens) AS total_tokens,
          min(coalesce(e.end_time, e.start_time)) AS recorded_at
        FROM llm_executions e
        JOIN tasks t ON t.task_id = e.task_id
        JOIN (
          SELECT l.task_id, l.session_id,
            CASE WHEN l.execution_type = 'implementation' THEN ${JOB_TYPE_BY_TASK_TYPE} ELSE l.execution_type END AS execution_type
          FROM llm_logs l
          JOIN tasks t ON t.task_id = l.task_id
        ) run ON run.task_id = e.task_id AND run.session_id = e.session_id
        WHERE e.success = ?
          AND e.input_tokens IS NOT NULL AND e.output_tokens IS NOT NULL
          AND e.session_id IS NOT NULL AND e.session_id NOT IN ('', 'unknown')
          AND e.model_name IS NOT NULL AND e.model_name <> ''
          AND trim(coalesce(t.repository, '')) <> ''
          AND NOT EXISTS (SELECT 1 FROM ${SAMPLES} s WHERE s.execution_id = e.execution_id)
        GROUP BY e.execution_id
        HAVING count(run.execution_type) = count(*) AND count(DISTINCT run.execution_type) = 1
      ) attributed
    ) ranked
    WHERE recency <= ?
  `, [true, true, MAX_BASELINE_RUNS]);
}

// The copied rows are indistinguishable from recorded ones, and keeping them is
// harmless once the table exists; the table's own migration drops them all.
export async function down() {}
