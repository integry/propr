import type { Knex } from 'knex';

type Row = Record<string, unknown>;
const object = (value: unknown): Row => {
  if (typeof value === 'string') {
    try { return object(JSON.parse(value)); } catch { return {}; }
  }
  return value && typeof value === 'object' ? value as Row : {};
};
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;

/**
 * An automation run's definition snapshot names its model only when it pinned
 * both the agent and the model; otherwise the run used defaults resolved at
 * execution time, which the snapshot does not record and must not be guessed.
 */
function agentRunSnapshotIdentity(run: Row | undefined) {
  const snapshot = object(run?.definition_snapshot);
  const modelName = text(snapshot.modelName), agentAlias = text(snapshot.agentAlias);
  return modelName && agentAlias ? { modelName, agentAlias } : null;
}

/** Execution evidence outranks submission-time routing, which may predate PR label resolution. */
export function taskModelIdentity(task: Row, history: Row[], executions: Row[] = [], agentRun?: Row) {
  const job = object(task.initial_job_data);
  const metadata = history.map(row => object(row.metadata)).reverse();
  // Synthetic tasks retain their virtual identity; physical attempts are shown separately.
  const synthetic = object(metadata.find(item => text(object(item.syntheticRouting).virtualModel))?.syntheticRouting);
  if (synthetic.virtualModel) return { modelName: text(synthetic.virtualModel), agentAlias: text(synthetic.virtualAgentAlias) || text(job.agentAlias) };
  const routed = object(metadata.find(item => item.executionRouting)?.executionRouting);
  const recordedModel = metadata.find(item => text(item.model))?.model;
  const execution = [...executions].reverse().find(row => text(row.model_name));
  const modelName = text(execution?.model_name) || text(recordedModel) || text(routed.model);
  if (modelName) {
    // Never pair execution evidence with a different submission-time provider.
    return { modelName, agentAlias: (modelName === routed.model ? text(routed.agentAlias) : null) || (modelName === job.modelName ? text(job.agentAlias) : null) };
  }
  // Automation report and action tasks record no model on the task row; their run's snapshot is the only other immutable source.
  if (task.task_type === 'agent-run') return agentRunSnapshotIdentity(agentRun) ?? { modelName: null, agentAlias: null };
  const isFollowup = task.task_type === 'pr-comment' || !!job.pullRequestNumber || String(task.task_id).startsWith('pr-comment');
  return {
    modelName: isFollowup ? text(job.modelName) || text(job.llm) : text(task.model_name),
    agentAlias: text(job.agentAlias),
  };
}

/** Batched and bounded to the requested page, including historical runs with stale task rows. */
export async function loadTaskModelIdentities(db: Knex, tasks: Row[]) {
  const ids = tasks.map(task => String(task.task_id));
  const [history, executions, agentRuns] = await Promise.all([
    db('task_history').whereIn('task_id', ids).select('task_id', 'metadata').orderBy('timestamp').orderBy('history_id'),
    db('llm_executions').whereIn('task_id', ids).select('task_id', 'model_name').orderBy('start_time').orderBy('execution_id'),
    loadAgentRunsByTask(db, tasks),
  ]);
  const group = (rows: Row[]) => {
    const result = new Map<string, Row[]>();
    for (const row of rows) {
      const key = String(row.task_id);
      if (!result.has(key)) result.set(key, []);
      result.get(key)!.push(row);
    }
    return result;
  };
  const histories = group(history), runs = group(executions);
  return new Map(tasks.map(task => [String(task.task_id), taskModelIdentity(task, histories.get(String(task.task_id)) || [], runs.get(String(task.task_id)) || [], agentRuns.get(String(task.task_id)))]));
}

/** The automation runs owning the given report or action tasks, keyed by task id. */
export async function loadAgentRunsByTask(db: Knex, tasks: Row[]): Promise<Map<string, Row>> {
  const ids = tasks.filter(task => task.task_type === 'agent-run').map(task => String(task.task_id));
  const result = new Map<string, Row>();
  if (ids.length === 0) return result;
  const rows: Row[] = await db('agent_runs').whereIn('report_task_id', ids).orWhereIn('action_task_id', ids)
    .select('report_task_id', 'action_task_id', 'definition_snapshot');
  for (const row of rows) {
    for (const taskId of [row.report_task_id, row.action_task_id]) {
      if (typeof taskId === 'string' && ids.includes(taskId)) result.set(taskId, row);
    }
  }
  return result;
}
