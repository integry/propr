/**
 * The Routing-managed installation suspension gap this Core is reconciling, one
 * row per installation. It records the exact routing/resume generation, the gap
 * interval (and the earlier recovery start it inherited from unfinished
 * superseded generations), reconciliation state and per-repository progress, and the completion
 * identity sent to Routing, so a daemon restart resumes the same work and a lost
 * completion response is retried with the same identity instead of rerunning
 * completed side effects.
 */
export async function up(knex) {
  if (await knex.schema.hasTable('routing_resume_resyncs')) return;
  await knex.schema.createTable('routing_resume_resyncs', (table) => {
    table.bigInteger('installation_id').primary();
    table.bigInteger('routing_generation').notNullable();
    table.bigInteger('resume_generation').notNullable();
    // 'pending' | 'reconciling' | 'partial' | 'failed' | 'completed' | 'acknowledged'
    table.string('state', 16).notNullable();
    table.string('gap_started_at').notNullable();
    // Effective discovery start: no later than gap_started_at, earlier when
    // this generation superseded unfinished predecessors it must still cover.
    table.string('recovery_started_at').notNullable();
    table.string('gap_ended_at').nullable();
    table.integer('attempts').notNullable().defaultTo(0);
    table.string('started_at').nullable();
    table.string('last_attempt_at').nullable();
    table.string('next_retry_at').nullable();
    table.text('last_error').nullable();
    // Per-repository and installation-level progress plus the consecutive
    // failure count, and the completion identity, as bounded JSON.
    table.text('progress_json').notNullable();
    table.text('completion_json').nullable();
    table.string('acknowledged_at').nullable();
    table.string('updated_at').notNullable();
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('routing_resume_resyncs');
}
