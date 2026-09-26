export async function up(knex) {
  await knex.schema.createTable('mcp_records', table => {
    table.string('kind', 32).notNullable();
    table.string('id', 255).notNullable();
    table.text('value').notNullable();
    table.string('owner_id').nullable();
    table.bigInteger('expires_at').nullable();
    table.primary(['kind', 'id']);
    table.index(['kind', 'expires_at']);
    table.index(['kind', 'owner_id', 'id']);
  });
  await knex.schema.createTable('mcp_operations', table => {
    table.uuid('id').primary();
    table.string('owner_id').notNullable();
    table.string('grant_id').notNullable();
    table.string('idempotency_key', 128).notNullable();
    table.string('tool').notNullable();
    table.string('repository').nullable();
    table.string('payload_hash', 64).notNullable();
    table.string('state').notNullable();
    table.text('result').nullable();
    table.bigInteger('created_at').notNullable();
    table.bigInteger('updated_at').notNullable();
    table.unique(['owner_id', 'grant_id', 'idempotency_key']);
  });
  await knex.schema.alterTable('task_drafts', table => { table.integer('mcp_revision').notNullable().defaultTo(0); });
  // Every writer, including browser handlers and background workers, invalidates
  // MCP revisions. Updating a plan twice within one timestamp tick stays safe.
  await knex.raw(`CREATE TRIGGER task_drafts_mcp_revision AFTER UPDATE ON task_drafts
    WHEN NEW.mcp_revision = OLD.mcp_revision
    BEGIN UPDATE task_drafts SET mcp_revision = OLD.mcp_revision + 1 WHERE draft_id = NEW.draft_id; END`);
}

export async function down(knex) {
  await knex.raw('DROP TRIGGER IF EXISTS task_drafts_mcp_revision');
  await knex.schema.alterTable('task_drafts', table => { table.dropColumn('mcp_revision'); });
  await knex.schema.dropTableIfExists('mcp_operations');
  await knex.schema.dropTableIfExists('mcp_records');
}
