// Plugin event subscriptions: the dispatcher's durable state.
//
// `plugin_dispatch` has one row per installation: the journal position its
// subscriptions start from (`start_seq`, "now" when it was installed or last
// enabled), the delivery lease (only one worker delivers per installation;
// the lease is a row with an expiry, not a database lock), and its delivery
// health (consecutive failures, last error, Degraded and paused times).
//
// `plugin_delivery_cursors` holds, per installation and repository, the last
// journal `seq` whose deliveries are final, and the journal floor already
// recorded as a gap.
//
// `plugin_deliveries` records each delivery (one journal event to one handler)
// and each gap: status, attempts, the latest attempt's duration, redacted
// error and log lines. The event payload is never stored, only its `seq` and
// type. Rows are pruned after a retention period.

export async function up(knex) {
  if (!await knex.schema.hasTable('plugin_dispatch')) {
    await knex.schema.createTable('plugin_dispatch', t => {
      t.string('plugin_id').primary();
      // The installation this state belongs to: a reinstall starts over.
      t.bigInteger('installed_at').notNullable();
      t.bigInteger('start_seq').notNullable();
      t.string('lease_owner');
      t.bigInteger('lease_expires_at');
      t.integer('consecutive_failures').notNullable().defaultTo(0);
      t.text('last_error');
      t.bigInteger('last_error_at');
      t.bigInteger('degraded_at');
      t.bigInteger('paused_at');
      t.bigInteger('updated_at').notNullable();
    });
  }
  if (!await knex.schema.hasTable('plugin_delivery_cursors')) {
    await knex.schema.createTable('plugin_delivery_cursors', t => {
      t.string('plugin_id').notNullable();
      t.string('repository').notNullable();
      t.bigInteger('cursor_seq').notNullable();
      // The journal floor last recorded as a gap, so a gap is recorded once.
      t.bigInteger('floor_seq').notNullable().defaultTo(1);
      t.primary(['plugin_id', 'repository']);
    });
  }
  if (!await knex.schema.hasTable('plugin_deliveries')) {
    await knex.schema.createTable('plugin_deliveries', t => {
      t.increments('id').primary();
      t.string('plugin_id').notNullable();
      t.string('delivery_id').notNullable();
      t.string('kind').notNullable();
      t.string('repository').notNullable();
      t.bigInteger('event_seq').notNullable();
      t.string('event_type');
      t.string('handler');
      t.string('status').notNullable();
      t.integer('attempt').notNullable().defaultTo(0);
      t.bigInteger('next_attempt_at');
      t.bigInteger('created_at').notNullable();
      t.bigInteger('started_at');
      t.bigInteger('finished_at');
      t.integer('duration_ms');
      t.boolean('timed_out').notNullable().defaultTo(false);
      t.text('error');
      t.text('logs').notNullable().defaultTo('[]');
      t.unique(['plugin_id', 'delivery_id']);
      t.index(['plugin_id', 'id']);
      t.index(['plugin_id', 'repository', 'status']);
      t.index(['created_at']);
    });
  }
}

// Delivery state is operational history; older versions ignore it.
export async function down() {}
