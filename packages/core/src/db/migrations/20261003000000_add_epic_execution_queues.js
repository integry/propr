export async function up(knex) {
  await knex.schema.createTable('epic_execution_queues', table => {
    table.string('draft_id').primary().references('draft_id').inTable('task_drafts').onDelete('CASCADE');
    table.string('execution_id').notNullable();
    table.string('repository').notNullable();
    table.text('issues').notNullable();
    table.integer('cursor').notNullable().defaultTo(0);
    table.string('status').notNullable().defaultTo('active');
    table.string('advance_on').notNullable().defaultTo('merged');
    table.text('blocked_reason').nullable();
    table.boolean('auto_merge').notNullable().defaultTo(false);
    table.boolean('ready').notNullable().defaultTo(true);
    table.bigInteger('head_started_at').nullable();
    table.bigInteger('created_at').notNullable();
    table.bigInteger('updated_at').notNullable();
    table.index(['status']);
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('epic_execution_queues');
}
