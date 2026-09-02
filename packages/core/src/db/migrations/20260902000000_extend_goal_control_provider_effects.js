/**
 * Goal-session runtime extension for the control database.  goal_events and
 * goal_messages are deliberately not created here: they belong to the #2018
 * control-plane migration and are consumed by the runtime adapter.
 */
export async function up(knex) {
  await knex.schema.createTable('goal_session_runtime_owners', (table) => {
    table.string('session_id').primary();
    table.string('goal_id').notNullable();
  });
  await knex.schema.createTable('goal_session_runtime_state', (table) => {
    table.string('scope').primary();
    table.text('payload_json').notNullable();
  });
  await knex.schema.createTable('goal_session_runtime_commits', (table) => {
    table.string('kind').notNullable();
    table.string('identity').notNullable();
    table.primary(['kind', 'identity']);
  });
  await knex.schema.createTable('goal_session_runtime_model_changes', (table) => {
    table.string('scope').notNullable();
    table.string('operation_id').notNullable();
    table.integer('sequence').notNullable();
    table.string('model').notNullable();
    table.string('status').notNullable();
    table.text('acknowledgement_json');
    table.primary(['scope', 'operation_id']);
    table.unique(['scope', 'sequence']);
  });
  await knex.schema.createTable('goal_session_runtime_model_sequences', (table) => {
    table.string('scope').primary();
    table.integer('next_sequence').notNullable();
  });
  await knex.schema.createTable('goal_session_runtime_provider_effects', (table) => {
    table.string('scope').notNullable();
    table.string('operation_id').notNullable();
    table.string('kind').notNullable();
    table.string('stage').notNullable();
    table.string('status').notNullable();
    table.text('outcome_json');
    table.timestamp('updated_at').notNullable();
    table.primary(['scope', 'operation_id', 'stage']);
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
  await knex.schema.dropTableIfExists('goal_session_runtime_owners');
}
