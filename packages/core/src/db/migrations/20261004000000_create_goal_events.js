/**
 * Durable, monotonic per-goal event journal backing bounded goal waits.
 *
 * A goal's lifecycle is written from HTTP controls, the goal worker and leased
 * recovery, and checkpoints from the checkpoint publisher. Rather than trusting
 * every one of those writers to append an event, the database derives events
 * from the committed columns themselves: a trigger appends a `lifecycle` row in
 * the same transaction whenever the derived state changes, and a `checkpoint`
 * row when a checkpoint is published. A notification can therefore never
 * create an event, a retry that re-saves the same state appends nothing, and a
 * transition is never visible in the row without its event.
 *
 * `sequence` is AUTOINCREMENT so a position is never reused, even after rows
 * are deleted; it is the opaque wait cursor's position.
 *
 * The derived state distinguishes requested from confirmed controls:
 * `pausing`/`cancelling`/`resuming` are requests; `paused` requires the
 * worker's pause confirmation with no queued resume, and `cancelled` requires
 * the cancelled result.
 */

/** Lifecycle state of a goals row, evaluated against NEW or OLD in a trigger. */
const lifecycleState = row => `CASE
  WHEN ${row}.result_state IN ('completed', 'failed', 'cancelled') THEN ${row}.result_state
  WHEN ${row}.desired_state = 'cancelled' THEN 'cancelling'
  WHEN ${row}.desired_state = 'paused' AND COALESCE(${row}.resume_requested, 0) <> 0 THEN 'resuming'
  WHEN ${row}.desired_state = 'paused' AND ${row}.pause_confirmed_at IS NOT NULL THEN 'paused'
  WHEN ${row}.desired_state = 'paused' THEN 'pausing'
  WHEN ${row}.claimed_at IS NULL AND ${row}.started_at IS NULL THEN 'queued'
  ELSE 'running'
END`;

const now = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

// A checkpoint is published work exactly once, even if its row is re-saved.
const checkpointUnrecorded = "NOT EXISTS (SELECT 1 FROM goal_events WHERE kind = 'checkpoint' AND checkpoint_id = NEW.checkpoint_id)";

const triggers = [
  `CREATE TRIGGER goal_events_lifecycle_insert AFTER INSERT ON goals
   BEGIN
     INSERT INTO goal_events (goal_id, kind, state, previous_state, run_generation, created_at)
     VALUES (NEW.goal_id, 'lifecycle', ${lifecycleState('NEW')}, NULL, NEW.run_generation, ${now});
   END`,
  `CREATE TRIGGER goal_events_lifecycle_update AFTER UPDATE ON goals
   WHEN (${lifecycleState('OLD')}) IS NOT (${lifecycleState('NEW')})
   BEGIN
     INSERT INTO goal_events (goal_id, kind, state, previous_state, run_generation, created_at)
     VALUES (NEW.goal_id, 'lifecycle', ${lifecycleState('NEW')}, ${lifecycleState('OLD')}, NEW.run_generation, ${now});
   END`,
  `CREATE TRIGGER goal_events_checkpoint_insert AFTER INSERT ON goal_checkpoints
   WHEN NEW.state = 'completed' AND ${checkpointUnrecorded}
   BEGIN
     INSERT INTO goal_events (goal_id, kind, checkpoint_id, created_at)
     VALUES (NEW.goal_id, 'checkpoint', NEW.checkpoint_id, ${now});
   END`,
  `CREATE TRIGGER goal_events_checkpoint_update AFTER UPDATE OF state ON goal_checkpoints
   WHEN NEW.state = 'completed' AND OLD.state IS NOT 'completed' AND ${checkpointUnrecorded}
   BEGIN
     INSERT INTO goal_events (goal_id, kind, checkpoint_id, created_at)
     VALUES (NEW.goal_id, 'checkpoint', NEW.checkpoint_id, ${now});
   END`,
];

export async function up(knex) {
  await knex.schema.createTable('goal_events', table => {
    table.increments('sequence').primary();
    table.uuid('goal_id').notNullable().references('goal_id').inTable('goals').onDelete('CASCADE');
    table.string('kind', 20).notNullable();
    table.string('state', 20);
    table.string('previous_state', 20);
    table.uuid('checkpoint_id');
    table.integer('run_generation');
    table.string('created_at', 32).notNullable();

    table.index(['goal_id', 'sequence']);
    table.index(['checkpoint_id']);
  });

  // Every existing goal starts its journal at its current state, and published
  // checkpoints keep their order, so a cursor taken now has a real boundary.
  await knex.raw(`INSERT INTO goal_events (goal_id, kind, state, run_generation, created_at)
    SELECT goal_id, 'lifecycle', ${lifecycleState('goals')}, run_generation, ${now}
    FROM goals ORDER BY created_at, goal_id`);
  await knex.raw(`INSERT INTO goal_events (goal_id, kind, checkpoint_id, created_at)
    SELECT goal_checkpoints.goal_id, 'checkpoint', goal_checkpoints.checkpoint_id, ${now}
    FROM goal_checkpoints JOIN goals ON goals.goal_id = goal_checkpoints.goal_id
    WHERE goal_checkpoints.state = 'completed'
    ORDER BY goal_checkpoints.completed_at, goal_checkpoints.checkpoint_id`);

  for (const trigger of triggers) await knex.raw(trigger);
}

export async function down(knex) {
  for (const name of ['goal_events_lifecycle_insert', 'goal_events_lifecycle_update', 'goal_events_checkpoint_insert', 'goal_events_checkpoint_update']) {
    await knex.raw(`DROP TRIGGER IF EXISTS ${name}`);
  }
  await knex.schema.dropTableIfExists('goal_events');
}
