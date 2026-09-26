/**
 * The delivered `message` carries provider-only attachment paths appended by ProPR. The goal
 * timeline must show the operator-authored body verbatim, so store that body and the attachment
 * count separately instead of parsing the generated framing back out of the prompt.
 */
export async function up(knex) {
  await knex.schema.alterTable('goal_inputs', table => {
    table.text('display_message');
    table.integer('attachment_count').notNullable().defaultTo(0);
  });
}

export async function down(knex) {
  await knex.schema.alterTable('goal_inputs', table => {
    table.dropColumn('display_message');
    table.dropColumn('attachment_count');
  });
}
