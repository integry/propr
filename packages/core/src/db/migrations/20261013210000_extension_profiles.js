import { randomUUID } from 'node:crypto';

export async function up(knex) {
  await knex.schema.createTable('extension_instance_identity', t => { t.integer('id').primary(); t.uuid('instance_id').notNullable(); });
  await knex('extension_instance_identity').insert({ id: 1, instance_id: randomUUID() });
  await knex.schema.createTable('extension_profiles', t => {
    t.uuid('id').primary(); t.uuid('instance_id').notNullable(); t.integer('revision').notNullable();
    t.boolean('enabled').notNullable(); t.boolean('deleted').notNullable().defaultTo(false); t.bigInteger('deleted_at'); t.string('deleted_by');
  });
  await knex.schema.createTable('extension_profile_revisions', t => {
    t.uuid('profile_id').notNullable().references('id').inTable('extension_profiles').onDelete('CASCADE');
    t.integer('revision').notNullable(); t.text('snapshot').notNullable(); t.text('secrets_encrypted').notNullable();
    t.primary(['profile_id', 'revision']);
  });
  await knex.schema.createTable('extension_skill_bundles', t => {
    t.uuid('id').primary(); t.uuid('instance_id').notNullable(); t.text('descriptor').notNullable(); t.text('files_json').notNullable();
  });
  await knex.schema.createTable('extension_run_grants', t => {
    t.string('token_hash').primary(); t.uuid('profile_id').notNullable().references('id').inTable('extension_profiles').onDelete('CASCADE');
    t.boolean('active').notNullable().defaultTo(false); t.integer('connections').notNullable().defaultTo(0);
    t.integer('revision').notNullable(); t.string('actor').notNullable(); t.string('task_id').notNullable();
    t.bigInteger('expires_at').notNullable(); t.integer('calls').notNullable().defaultTo(0); t.integer('bytes').notNullable().defaultTo(0);
  });
  await knex.schema.alterTable('agent_definitions', t => { t.text('extension_profile'); });
}
export async function down(knex) {
  await knex.schema.alterTable('agent_definitions', t => { t.dropColumn('extension_profile'); });
  for (const table of ['extension_run_grants', 'extension_profile_revisions', 'extension_profiles', 'extension_skill_bundles', 'extension_instance_identity']) await knex.schema.dropTableIfExists(table);
}
