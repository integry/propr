/** SQLite triggers cover ALL writers, including direct SQL, rollback and deletion/ABA.
 * The global epoch intentionally also fences proofs when an unrelated member changes.
 * Current permissions are role-derived; a future permission-table migration MUST
 * advance this epoch and install equivalent triggers before changing that policy. */
export async function up(knex) {
  await knex.schema.createTable('native_authority_epoch', t => {
    t.integer('id').primary(); t.bigInteger('epoch').notNullable();
  });
  await knex('native_authority_epoch').insert({ id: 1, epoch: 1 });
  for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
    await knex.raw(`CREATE TRIGGER native_authority_${event.toLowerCase()} AFTER ${event} ON instance_members BEGIN
      SELECT CASE WHEN (SELECT epoch FROM native_authority_epoch WHERE id = 1) >= 9007199254740991
        THEN RAISE(ABORT, 'Native authority epoch exhausted') END;
      UPDATE native_authority_epoch SET epoch = epoch + 1 WHERE id = 1;
    END`);
  }
  await knex.schema.createTable('extension_authority_challenges', t => { t.text('challenge').primary(); });
  await knex.schema.createTable('extension_authority_operations', t => {
    t.text('operation_id').primary(); t.text('commitment').notNullable(); t.text('epoch').notNullable();
    t.boolean('dispatched').notNullable().defaultTo(false); t.boolean('completed').notNullable().defaultTo(false);
  });
}
export async function down(knex) {
  for (const event of ['insert', 'update', 'delete']) await knex.raw(`DROP TRIGGER IF EXISTS native_authority_${event}`);
  for (const table of ['extension_authority_operations', 'extension_authority_challenges', 'native_authority_epoch']) await knex.schema.dropTableIfExists(table);
}
