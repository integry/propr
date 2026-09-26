import { randomUUID } from 'node:crypto';

// Generation numbers can repeat after deletion. Give existing and future rows
// separate lifetimes without discarding any pending restoration obligations.
export async function up(knex) {
    await knex.schema.alterTable('pr_ci_suspensions', table => {
        table.string('incarnation', 36).notNullable().defaultTo('legacy');
    });
    const rows = await knex('pr_ci_suspensions').select('repository', 'pull_request');
    for (const row of rows) {
        await knex('pr_ci_suspensions').where(row).update({ incarnation: randomUUID() });
    }
}

export async function down(knex) {
    await knex.schema.alterTable('pr_ci_suspensions', table => table.dropColumn('incarnation'));
}
