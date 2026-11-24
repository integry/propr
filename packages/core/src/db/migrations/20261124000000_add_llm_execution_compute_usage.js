// Compute usage of the agent run behind an execution, reported by its runtime
// (Docker samples the container's cgroup; metered runtimes report their own):
// wall time, CPU-seconds, peak and average memory, and the compute cost with
// where it came from (`runtime` or the `rate_table` in PROPR_COMPUTE_RATES).
// Every column is nullable: older rows and runs no runtime measured stay null,
// never zero, so an unmeasured run cannot read as one that used nothing.
const COLUMNS = [
  ['compute_runtime', table => table.string('compute_runtime', 32).nullable()],
  ['compute_wall_time_ms', table => table.bigInteger('compute_wall_time_ms').nullable()],
  ['compute_cpu_seconds', table => table.double('compute_cpu_seconds').nullable()],
  ['compute_peak_memory_bytes', table => table.bigInteger('compute_peak_memory_bytes').nullable()],
  ['compute_avg_memory_bytes', table => table.bigInteger('compute_avg_memory_bytes').nullable()],
  ['compute_cost_usd', table => table.double('compute_cost_usd').nullable()],
  ['compute_cost_source', table => table.string('compute_cost_source', 16).nullable()],
];

export async function up(knex) {
  for (const [name, add] of COLUMNS) {
    if (await knex.schema.hasColumn('llm_executions', name)) continue;
    await knex.schema.alterTable('llm_executions', table => { add(table); });
  }
}

export async function down(knex) {
  for (const [name] of [...COLUMNS].reverse()) {
    if (!(await knex.schema.hasColumn('llm_executions', name))) continue;
    await knex.schema.alterTable('llm_executions', table => { table.dropColumn(name); });
  }
}
