/**
 * Create the durable notification schema.
 *
 * Notification events are immutable and recipient-independent. Read/dismiss
 * state, preferences, subscriptions, delivery attempts, and source activity
 * are stored separately so each concern can evolve without rewriting history.
 *
 * SQLite's timestamp coercion varies across drivers, so every timestamp in
 * these tables is explicitly stored as ISO-8601 TEXT.
 */

const isoNow = (knex) => knex.raw("(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))");

export async function up(knex) {
  await knex.schema.createTable('notification_events', (table) => {
    table.text('event_id').primary();
    table.text('deduplication_key').notNullable();
    table.text('kind').notNullable();
    table.text('severity').notNullable().defaultTo('info');
    table.text('target_json').notNullable();
    table.text('title').notNullable();
    table.text('body').notNullable();
    table.text('action_json').nullable();
    table.text('metadata_json').nullable();
    table.text('occurred_at').notNullable().defaultTo(isoNow(knex));
    table.text('created_at').notNullable().defaultTo(isoNow(knex));

    table.check(
      "kind IN ('plan', 'task', 'review', 'pull_request', 'indexing', 'system_failure')",
      {},
      'notification_events_kind_check'
    );
    table.check(
      "severity IN ('info', 'success', 'warning', 'error')",
      {},
      'notification_events_severity_check'
    );
    table.check(
      "CASE WHEN json_valid(target_json) THEN COALESCE(json_type(target_json) = 'object', 0) ELSE 0 END",
      {},
      'notification_events_target_json_check'
    );
    table.check(
      "CASE WHEN json_valid(target_json) THEN COALESCE(json_extract(target_json, '$.type') = kind, 0) ELSE 0 END",
      {},
      'notification_events_target_kind_check'
    );
    table.check(
      "CASE WHEN action_json IS NULL THEN 1 WHEN json_valid(action_json) THEN COALESCE(json_type(action_json) = 'object' AND json_extract(action_json, '$.type') IN ('navigate', 'external_link'), 0) ELSE 0 END",
      {},
      'notification_events_action_json_check'
    );
    table.check(
      "CASE WHEN metadata_json IS NULL THEN 1 WHEN json_valid(metadata_json) THEN COALESCE(json_type(metadata_json) = 'object', 0) ELSE 0 END",
      {},
      'notification_events_metadata_json_check'
    );
  });

  await knex.raw(
    'CREATE UNIQUE INDEX notification_events_deduplication_key_idx ON notification_events (deduplication_key)'
  );
  await knex.raw(
    'CREATE INDEX notification_events_occurred_at_idx ON notification_events (occurred_at DESC, event_id)'
  );

  // Events are an append-only audit record. Recipient state remains mutable in
  // the separate table below.
  await knex.raw(`
    CREATE TRIGGER notification_events_immutable_update
    BEFORE UPDATE ON notification_events
    BEGIN
      SELECT RAISE(ABORT, 'notification events are immutable');
    END
  `);
  await knex.raw(`
    CREATE TRIGGER notification_events_immutable_delete
    BEFORE DELETE ON notification_events
    BEGIN
      SELECT RAISE(ABORT, 'notification events are immutable');
    END
  `);

  await knex.schema.createTable('notification_user_states', (table) => {
    table.text('event_id').notNullable();
    table.text('user_id').notNullable();
    table.text('read_at').nullable();
    table.text('dismissed_at').nullable();
    table.text('created_at').notNullable().defaultTo(isoNow(knex));

    table.primary(['event_id', 'user_id']);
    table
      .foreign('event_id')
      .references('event_id')
      .inTable('notification_events')
      .onUpdate('RESTRICT')
      .onDelete('RESTRICT');
  });

  // Recipient assignment time (created_at), rather than event occurrence time,
  // is the canonical Inbox cursor. Delayed assignments and backfilled events
  // therefore appear when the recipient actually receives them, and the query
  // can use one state-table index for its complete ordering.
  await knex.raw(`
    CREATE INDEX notification_user_states_visible_idx
    ON notification_user_states (user_id, created_at DESC, event_id DESC)
    WHERE dismissed_at IS NULL
  `);

  // The narrower partial index keeps unread badge counts and unread-only Inbox
  // pages from scanning visible rows that have already been read.
  await knex.raw(`
    CREATE INDEX notification_user_states_unread_idx
    ON notification_user_states (user_id, created_at DESC, event_id DESC)
    WHERE read_at IS NULL AND dismissed_at IS NULL
  `);

  await knex.schema.createTable('notification_preferences', (table) => {
    table.text('user_id').notNullable();
    table.text('notification_kind').notNullable();
    table.boolean('inbox_enabled').notNullable().defaultTo(true);
    table.boolean('push_enabled').notNullable().defaultTo(true);
    table.text('created_at').notNullable().defaultTo(isoNow(knex));
    table.text('updated_at').notNullable().defaultTo(isoNow(knex));

    table.primary(['user_id', 'notification_kind']);
    table.check(
      "notification_kind IN ('plan', 'task', 'review', 'pull_request', 'indexing', 'system_failure')",
      {},
      'notification_preferences_kind_check'
    );
  });

  await knex.schema.createTable('push_subscriptions', (table) => {
    table.text('subscription_id').primary();
    table.text('user_id').notNullable();
    table.text('endpoint').notNullable();
    table.text('p256dh_key').notNullable();
    table.text('auth_key').notNullable();
    table.text('expires_at').nullable();
    table.text('user_agent').nullable();
    table.text('last_used_at').nullable();
    table.text('revoked_at').nullable();
    table.text('created_at').notNullable().defaultTo(isoNow(knex));
    table.text('updated_at').notNullable().defaultTo(isoNow(knex));
  });

  // Only an active endpoint is unique. Revoked rows remain immutable identities
  // for delivery history, while a later registration can version the endpoint
  // under a different user after account switching.
  await knex.raw(`
    CREATE UNIQUE INDEX push_subscriptions_active_endpoint_idx
    ON push_subscriptions (endpoint)
    WHERE revoked_at IS NULL
  `);
  // Supports the composite delivery foreign key that verifies subscription
  // ownership without requiring a separate users table.
  await knex.raw(`
    CREATE UNIQUE INDEX push_subscriptions_id_user_idx
    ON push_subscriptions (subscription_id, user_id)
  `);
  await knex.raw(`
    CREATE INDEX push_subscriptions_active_user_idx
    ON push_subscriptions (user_id, subscription_id)
    WHERE revoked_at IS NULL
  `);

  await knex.schema.createTable('push_delivery_attempts', (table) => {
    table.text('attempt_id').primary();
    table.text('deduplication_key').notNullable();
    table.text('event_id').notNullable();
    table.text('user_id').notNullable();
    table.text('subscription_id').notNullable();
    table.integer('attempt_number').notNullable().defaultTo(1);
    table.text('status').notNullable().defaultTo('pending');
    table.integer('response_status').nullable();
    table.text('error_code').nullable();
    table.text('error_message').nullable();
    table.text('attempted_at').nullable();
    table.text('next_retry_at').nullable();
    table.text('created_at').notNullable().defaultTo(isoNow(knex));

    table.check(
      "status IN ('pending', 'delivered', 'retryable', 'failed')",
      {},
      'push_delivery_attempts_status_check'
    );
    table.check(
      'attempt_number > 0',
      {},
      'push_delivery_attempts_number_check'
    );
    table.check(
      "(status = 'pending' AND attempted_at IS NULL AND next_retry_at IS NULL) OR (status = 'retryable' AND attempted_at IS NOT NULL AND next_retry_at IS NOT NULL) OR (status IN ('delivered', 'failed') AND attempted_at IS NOT NULL AND next_retry_at IS NULL)",
      {},
      'push_delivery_attempts_timestamps_check'
    );

    table
      .foreign(['event_id', 'user_id'])
      .references(['event_id', 'user_id'])
      .inTable('notification_user_states')
      .onUpdate('RESTRICT')
      .onDelete('RESTRICT');
    table
      .foreign(['subscription_id', 'user_id'])
      .references(['subscription_id', 'user_id'])
      .inTable('push_subscriptions')
      .onUpdate('RESTRICT')
      .onDelete('RESTRICT');
  });

  await knex.raw(
    'CREATE UNIQUE INDEX push_delivery_attempts_deduplication_key_idx ON push_delivery_attempts (deduplication_key)'
  );
  await knex.raw(`
    CREATE UNIQUE INDEX push_delivery_attempts_event_subscription_attempt_idx
    ON push_delivery_attempts (event_id, subscription_id, attempt_number)
  `);
  // Pending rows are undispatched and recoverable in insertion order. Retried
  // attempts use their required schedule timestamp in the separate index.
  await knex.raw(`
    CREATE INDEX push_delivery_attempts_pending_idx
    ON push_delivery_attempts (created_at, attempt_id)
    WHERE status = 'pending'
  `);
  await knex.raw(`
    CREATE INDEX push_delivery_attempts_retry_idx
    ON push_delivery_attempts (next_retry_at, attempt_id)
    WHERE status = 'retryable' AND next_retry_at IS NOT NULL
  `);

  await knex.schema.createTable('notification_source_activity', (table) => {
    table.text('activity_type').notNullable();
    table.text('activity_key').notNullable();
    table.text('repository').notNullable();
    table.text('branch').nullable();
    table.text('status').notNullable();
    table.text('last_activity_at').notNullable();
    table.text('completed_at').nullable();
    table.text('metadata_json').nullable();
    table.text('created_at').notNullable().defaultTo(isoNow(knex));
    table.text('updated_at').notNullable().defaultTo(isoNow(knex));

    table.primary(['activity_type', 'activity_key']);
    table.check(
      "activity_type IN ('task', 'indexing')",
      {},
      'notification_source_activity_type_check'
    );
    table.check(
      "CASE WHEN metadata_json IS NULL THEN 1 WHEN json_valid(metadata_json) THEN COALESCE(json_type(metadata_json) = 'object', 0) ELSE 0 END",
      {},
      'notification_source_activity_metadata_json_check'
    );
  });

  // Active rows ordered by their last heartbeat are exactly the candidate set
  // a later stalled-work monitor needs to scan.
  await knex.raw(`
    CREATE INDEX notification_source_activity_stalled_idx
    ON notification_source_activity (activity_type, last_activity_at, activity_key)
    WHERE completed_at IS NULL
  `);
}

export async function down(knex) {
  await knex.raw('DROP TRIGGER IF EXISTS notification_events_immutable_delete');
  await knex.raw('DROP TRIGGER IF EXISTS notification_events_immutable_update');

  await knex.schema.dropTableIfExists('notification_source_activity');
  await knex.schema.dropTableIfExists('push_delivery_attempts');
  await knex.schema.dropTableIfExists('push_subscriptions');
  await knex.schema.dropTableIfExists('notification_preferences');
  await knex.schema.dropTableIfExists('notification_user_states');
  await knex.schema.dropTableIfExists('notification_events');
}
