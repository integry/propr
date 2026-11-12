/**
 * Journal goal blockers in `goal_events`, so a bounded goal wait (MCP
 * `wait_goal`, `propr goal wait`) can return when a goal starts waiting on its
 * operator.
 *
 * As with lifecycle and checkpoint events, the database derives the events
 * from the committed `goal_blockers` rows: an `open` event in the transaction
 * that inserts an open blocker, and a closing event (`resolved` or
 * `superseded`, with `previous_state` `open`) in the one that closes it. A
 * refreshed observation of the same request updates no status and appends
 * nothing, and a closed blocker is never reopened, so each blocker journals at
 * most one opening and one closing.
 *
 * Blockers opened before this migration have no journal entry, and a refreshed
 * observation appends none, so the migration journals an `open` event for each
 * blocker that is still open for its goal's current attempt. Without it a
 * cursorless `until: blocked` wait could never see a blocker that is already
 * waiting on the operator. Blockers of an earlier attempt or a finished goal
 * are left unjournaled, as no wait can match them.
 *
 * Adding a nullable column without a foreign key is a plain `ALTER TABLE ADD
 * COLUMN` in SQLite, so `goal_events` is not rebuilt. These triggers belong to
 * `goal_blockers`: a later migration that rebuilds that table must recreate
 * them. `test/goalMigration.test.ts` fails when one is missing.
 */

const now = 'CURRENT_TIMESTAMP';

const triggers = [
  `CREATE TRIGGER goal_events_blocker_insert AFTER INSERT ON goal_blockers
   WHEN NEW.status = 'open'
   BEGIN
     INSERT INTO goal_events (goal_id, kind, state, previous_state, blocker_id, run_generation, created_at)
     VALUES (NEW.goal_id, 'blocker', 'open', NULL, NEW.blocker_id, NEW.run_generation, ${now});
   END`,
  `CREATE TRIGGER goal_events_blocker_update AFTER UPDATE OF status ON goal_blockers
   WHEN OLD.status = 'open' AND NEW.status IS NOT 'open'
   BEGIN
     INSERT INTO goal_events (goal_id, kind, state, previous_state, blocker_id, run_generation, created_at)
     VALUES (NEW.goal_id, 'blocker', NEW.status, 'open', NEW.blocker_id, NEW.run_generation, ${now});
   END`,
];

export async function up(knex) {
  await knex.schema.alterTable('goal_events', table => {
    table.uuid('blocker_id');
    table.index(['blocker_id']);
  });
  await knex.raw(`INSERT INTO goal_events (goal_id, kind, state, previous_state, blocker_id, run_generation, created_at)
    SELECT goal_blockers.goal_id, 'blocker', 'open', NULL, goal_blockers.blocker_id, goal_blockers.run_generation, ${now}
    FROM goal_blockers JOIN goals ON goals.goal_id = goal_blockers.goal_id
    WHERE goal_blockers.status = 'open' AND goals.result_state IS NULL
      AND goal_blockers.run_claim = goals.run_claim AND goal_blockers.run_generation = goals.run_generation
    ORDER BY goal_blockers.first_observed_at, goal_blockers.blocker_id`);
  for (const trigger of triggers) await knex.raw(trigger);
}

export async function down(knex) {
  for (const name of ['goal_events_blocker_insert', 'goal_events_blocker_update']) {
    await knex.raw(`DROP TRIGGER IF EXISTS ${name}`);
  }
  await knex('goal_events').where({ kind: 'blocker' }).del();
  // Native DROP COLUMN, so `goal_events` is not rebuilt underneath the
  // `goals` and `goal_checkpoints` triggers that write to it.
  await knex.schema.alterTable('goal_events', table => { table.dropIndex(['blocker_id']); });
  await knex.raw('ALTER TABLE goal_events DROP COLUMN blocker_id');
}
