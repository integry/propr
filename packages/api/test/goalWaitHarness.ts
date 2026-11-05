import { fileURLToPath } from 'node:url';
import knex, { type Knex } from 'knex';
import { waitForGoal, type GoalWaitOptions } from '../services/goalWait.js';

/** Shared fixtures for the goal wait service tests. */
const migrations = fileURLToPath(new URL('../../core/src/db/migrations/', import.meta.url));
export const repository = 'acme/repo';
export const ownerId = '123';
export const goalId = '11111111-1111-4111-8111-111111111111';
export const otherGoalId = '22222222-2222-4222-8222-222222222222';

const goalDefaults = {
  owner_id: ownerId, owner_login: 'tester', repository, objective: 'Fixture objective', launch_strategy: 'direct',
  initial_prompt: 'Fixture prompt', agent_id: 'codex', agent_alias: 'codex', agent_type: 'codex',
  requested_model: 'fixture-model', desired_state: 'running', artifact_refs: '[]', artifact_stats: '{}',
  run_generation: 1, run_claim: 'claim-1', paused_ms: 0, resume_requested: false,
  control_generation: 0, control_ack_generation: 0, checkpoint_count: 0,
};

export async function openDatabase(filename = ':memory:'): Promise<Knex> {
  const database = knex({ client: 'better-sqlite3', connection: { filename }, useNullAsDefault: true });
  await database.migrate.latest({ directory: migrations });
  return database;
}

export async function insertGoal(database: Knex, values: Record<string, unknown> = {}): Promise<void> {
  const id = String(values.goal_id ?? goalId);
  await database('goals').insert({ ...goalDefaults, goal_id: id, current_task_id: `goal-task-${id}`, ...values });
}

/** Helpers bound to the test file's current database. */
export function goalWaitHarness(db: () => Knex) {
  const update = (values: Record<string, unknown>, id = goalId) => db()('goals').where({ goal_id: id }).update(values);

  async function insertCheckpoint(checkpointId: string, state: string): Promise<void> {
    await db()('goal_checkpoints').insert({
      checkpoint_id: checkpointId, goal_id: goalId, owner_id: ownerId, idempotency_key: `checkpoint-${checkpointId}`,
      operation: 'goal.checkpoint', payload_hash: 'hash', kind: 'agent', state, requested_generation: 1,
      commit_sha: state === 'completed' ? 'abc123' : null,
    });
  }

  function wait(options: Partial<GoalWaitOptions> = {}) {
    return waitForGoal({ db: db(), ownerId, goalId, repository, timeoutSeconds: 0.3, pollIntervalMs: 25, ...options });
  }

  const journal = async (id = goalId) =>
    (await db()('goal_events').where({ goal_id: id }).orderBy('sequence')).map(row => row.kind === 'checkpoint' ? `checkpoint:${row.checkpoint_id}` : row.state);

  return { update, insertCheckpoint, wait, journal };
}
