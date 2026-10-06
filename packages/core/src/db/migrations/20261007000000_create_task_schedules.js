/**
 * Scheduled (recurring) tasks.
 *
 * `task_schedules` holds one row per schedule. `instruction` is JSON in the
 * shape of a REST task submission (text plus agent/model and automation
 * overrides). `next_run_at` is the next slot the daemon may dispatch; it is
 * always computed after "now", so a new schedule never fires for a past slot
 * and slots missed while the daemon was down are skipped rather than replayed.
 *
 * `task_schedule_runs` is the schedule's timeline: one row per dispatched,
 * skipped or manual run. `idempotency_key` (`schedule:<id>:<slot>`) is unique,
 * so two ticks racing for the same slot cannot both dispatch it.
 *
 * `schedule_id` on `task_submissions` and `tasks` carries the provenance.
 */
export async function up(knex) {
  await knex.schema.createTable('task_schedules', table => {
    table.uuid('id').primary();
    table.string('name', 200).notNullable();
    table.string('repository', 255).notNullable();
    table.string('cron', 200).notNullable();
    table.string('timezone', 100).notNullable();
    table.text('instruction').notNullable();
    table.boolean('enabled').notNullable().defaultTo(true);
    table.string('owner_user_id', 255).notNullable();
    table.string('owner_username', 255).notNullable();
    table.text('last_run_at');
    table.text('next_run_at');
    table.integer('consecutive_failures').notNullable().defaultTo(0);
    table.text('paused_reason');
    table.text('created_at').notNullable();
    table.text('updated_at').notNullable();

    table.index(['enabled', 'next_run_at'], 'task_schedules_due_index');
    table.index(['repository'], 'task_schedules_repository_index');
  });

  await knex.schema.createTable('task_schedule_runs', table => {
    table.increments('id').primary();
    table.uuid('schedule_id').notNullable().references('id').inTable('task_schedules').onDelete('CASCADE');
    table.string('idempotency_key', 255).notNullable().unique();
    table.text('slot').notNullable();
    table.string('trigger', 20).notNullable();
    table.string('status', 20).notNullable();
    table.text('reason');
    table.string('submission_id', 36);
    table.string('task_id', 255);
    table.text('created_at').notNullable();
    table.text('finished_at');

    table.check("trigger IN ('schedule', 'manual')", {}, 'task_schedule_runs_trigger_check');
    table.check("status IN ('dispatching', 'dispatched', 'succeeded', 'failed', 'cancelled', 'skipped')", {}, 'task_schedule_runs_status_check');
    table.index(['schedule_id', 'created_at'], 'task_schedule_runs_schedule_index');
    table.index(['status'], 'task_schedule_runs_status_index');
  });

  await knex.raw('ALTER TABLE task_submissions ADD COLUMN schedule_id varchar(36) NULL');
  await knex.raw('ALTER TABLE tasks ADD COLUMN schedule_id varchar(36) NULL');
  await knex.raw('CREATE INDEX tasks_schedule_id_index ON tasks (schedule_id)');
}

export async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS tasks_schedule_id_index');
  await knex.raw('ALTER TABLE tasks DROP COLUMN schedule_id');
  await knex.raw('ALTER TABLE task_submissions DROP COLUMN schedule_id');
  await knex.schema.dropTableIfExists('task_schedule_runs');
  await knex.schema.dropTableIfExists('task_schedules');
}
