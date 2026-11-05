// Agent Tank usage history recorded by ProPR itself. Bundled Agent Tank runs in
// a disposable container whose own history database is discarded after every
// run, so the usage line charts need a store that outlives it. One row per
// metric per observed snapshot, in the same shape as Agent Tank 0.10's
// `usage_metrics` table so either source answers the same series query.
export async function up(knex) {
    await knex.schema.createTable('agent_tank_usage_history', table => {
        table.increments('id').primary();
        // ProPR-facing provider name: claude | codex | antigravity.
        table.string('agent', 64).notNullable();
        table.string('metric_key', 255).notNullable();
        table.string('metric_label', 255).notNullable();
        table.string('model', 255);
        table.string('cycle', 32);
        table.float('percent_used').notNullable();
        table.string('recorded_at', 32).notNullable();
        table.bigInteger('recorded_at_ms').notNullable();
        table.index(['agent', 'recorded_at_ms'], 'idx_agent_tank_usage_history_agent_time');
        table.index(['agent', 'metric_key', 'recorded_at_ms'], 'idx_agent_tank_usage_history_series');
    });
}

export async function down(knex) {
    await knex.schema.dropTableIfExists('agent_tank_usage_history');
}
