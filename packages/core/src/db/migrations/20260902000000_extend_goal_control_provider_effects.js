/**
 * Goal-session runtime extension for the control database.  goal_events and
 * goal_messages are deliberately not created here: they belong to the #2018
 * control-plane migration and are consumed by the runtime adapter.
 */
export async function up(knex) {
  await knex.schema.createTable('goal_session_runtime_state', (table) => {
    table.string('session_id').primary();
    table.string('goal_id').notNullable();
    table.string('scope').notNullable().unique();
    table.text('payload_json').notNullable();
    table.foreign('session_id').references('session_id').inTable('goal_provider_sessions').onDelete('CASCADE');
    table.foreign('goal_id').references('goal_id').inTable('goals').onDelete('CASCADE');
  });
  await knex.schema.createTable('goal_session_runtime_commits', (table) => {
    table.string('session_id').notNullable();
    table.string('goal_id').notNullable();
    table.string('kind').notNullable();
    table.string('identity').notNullable();
    table.primary(['kind', 'identity']);
    table.foreign('session_id').references('session_id').inTable('goal_provider_sessions').onDelete('CASCADE');
  });
  await knex.schema.createTable('goal_session_runtime_model_changes', (table) => {
    table.string('session_id').notNullable();
    table.string('goal_id').notNullable();
    table.string('scope').notNullable();
    table.string('operation_id').notNullable();
    table.integer('sequence').notNullable();
    table.string('model').notNullable();
    table.string('status').notNullable();
    table.text('acknowledgement_json');
    table.primary(['scope', 'operation_id']);
    table.unique(['scope', 'sequence']);
    table.foreign('session_id').references('session_id').inTable('goal_provider_sessions').onDelete('CASCADE');
  });
  await knex.schema.createTable('goal_session_runtime_model_sequences', (table) => {
    table.string('session_id').notNullable();
    table.string('goal_id').notNullable();
    table.string('scope').primary();
    table.integer('next_sequence').notNullable();
    table.foreign('session_id').references('session_id').inTable('goal_provider_sessions').onDelete('CASCADE');
  });
  await knex.schema.createTable('goal_session_runtime_provider_effects', (table) => {
    table.string('session_id').notNullable();
    table.string('goal_id').notNullable();
    table.string('scope').notNullable();
    table.string('operation_id').notNullable();
    table.string('kind').notNullable();
    table.string('stage').notNullable();
    table.string('status').notNullable();
    table.string('claim_token').notNullable();
    table.text('outcome_json');
    table.timestamp('updated_at').notNullable();
    table.primary(['scope', 'operation_id', 'stage']);
    table.foreign('session_id').references('session_id').inTable('goal_provider_sessions').onDelete('CASCADE');
    table.check("kind IN ('open','turn','resume','reconcile','steer','model','pause','cancel')");
    table.check("stage IN ('provider_primitive','stream_first_next','container_spawn')");
    table.check("status IN ('unstarted','started','recoverable','settled','poisoned')");
    table.check('length(operation_id) BETWEEN 1 AND 255 AND length(claim_token) BETWEEN 1 AND 255');
  });
  await knex.raw(`CREATE TRIGGER goal_runtime_provider_effect_stage_insert
    BEFORE INSERT ON goal_session_runtime_provider_effects
    WHEN NEW.stage NOT IN ('provider_primitive', 'stream_first_next', 'container_spawn')
    BEGIN SELECT RAISE(ABORT, 'invalid provider effect stage'); END`);
  await knex.raw(`CREATE TRIGGER goal_runtime_provider_effect_stage_update
    BEFORE UPDATE OF stage ON goal_session_runtime_provider_effects
    WHEN NEW.stage NOT IN ('provider_primitive', 'stream_first_next', 'container_spawn')
    BEGIN SELECT RAISE(ABORT, 'invalid provider effect stage'); END`);
}

export async function down(knex) {
  await knex.raw('DROP TRIGGER IF EXISTS goal_runtime_provider_effect_stage_update');
  await knex.raw('DROP TRIGGER IF EXISTS goal_runtime_provider_effect_stage_insert');
  await knex.schema.dropTableIfExists('goal_session_runtime_provider_effects');
  await knex.schema.dropTableIfExists('goal_session_runtime_model_sequences');
  await knex.schema.dropTableIfExists('goal_session_runtime_model_changes');
  await knex.schema.dropTableIfExists('goal_session_runtime_commits');
  await knex.schema.dropTableIfExists('goal_session_runtime_state');
}
