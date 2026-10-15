/** Append-only bounded metadata. No customer input or native results belong here. */
export async function up(knex) {
  await knex.schema.createTable('extension_authority_v2_clock', t => { t.integer('id').primary(); t.bigInteger('checked_ms').notNullable(); });
  await knex('extension_authority_v2_clock').insert({ id: 1, checked_ms: 0 });
  await knex.schema.createTable('extension_authority_v2_operations', t => {
    t.text('operation_id').primary(); t.text('work_digest').notNullable(); t.text('nonce').notNullable().unique();
    t.text('trust_digest').notNullable(); t.text('core_key_digest').notNullable();
  });
  await knex.schema.createTable('extension_authority_v2_intents', t => {
    t.text('challenge').primary(); t.text('operation_id').notNullable(); t.text('phase').notNullable();
    t.text('envelope_digest').notNullable();
  });
  await knex.raw("CREATE UNIQUE INDEX extension_authority_v2_phase ON extension_authority_v2_intents(operation_id, phase) WHERE phase != 'status'");
  await knex.schema.createTable('extension_authority_v2_receipts', t => {
    t.text('challenge').primary().references('challenge').inTable('extension_authority_v2_intents');
    t.text('response').notNullable(); t.text('response_digest').notNullable();
  });
  for (const table of ['operations', 'intents', 'receipts']) for (const event of ['UPDATE', 'DELETE']) {
    await knex.raw(`CREATE TRIGGER extension_authority_v2_${table}_${event.toLowerCase()} BEFORE ${event} ON extension_authority_v2_${table} BEGIN SELECT RAISE(ABORT, 'Immutable extension authority record'); END`);
  }
}
export async function down(knex) {
  for (const table of ['receipts', 'intents', 'operations', 'clock']) await knex.schema.dropTableIfExists(`extension_authority_v2_${table}`);
}
