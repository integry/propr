/* eslint-disable max-lines -- SQLite table rebuild preserves notification delivery invariants */

/**
 * Add authenticated preference settings and browser enrollment semantics.
 *
 * Category Push defaults become opt-in, quiet hours live once per user, and a
 * subscription's encryption material can be refreshed in place by endpoint.
 * Subscription identity and delivery audit references remain immutable.
 */

const ISO_NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const ISO_TIMESTAMP_GLOB = '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z';
const JAVASCRIPT_WHITESPACE_CODEPOINTS = [
  9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197,
  8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279,
];
const CONTROL_CODEPOINTS = [...Array.from({ length: 32 }, (_, index) => index), 127];
const WEB_PUSH_ENDPOINT_HOSTS = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
];
const WEB_PUSH_ENDPOINT_HOST_SUFFIXES = ['.push.apple.com'];
const JAVASCRIPT_WHITESPACE_SQL = [
  "' '",
  ...JAVASCRIPT_WHITESPACE_CODEPOINTS
    .filter((codepoint) => codepoint !== 32)
    .map((codepoint) => `char(${codepoint})`),
].join(' || ');

// Foreign-key enforcement must be disabled before the table rebuild begins, so
// Knex cannot wrap this migration for us. up()/down() acquire one connection and
// create their own transaction after changing that connection-local PRAGMA.
export const config = { transaction: false };

function configuredLocalhostOptIn() {
  const value = process.env.PROPR_ALLOW_INSECURE_LOCAL_WEB_PUSH?.trim().toLowerCase();
  return value === 'true' || value === '1';
}

function excludesCodepoints(value, codepoints) {
  return codepoints
    .map((codepoint) => `instr(${value}, char(${codepoint})) = 0`)
    .join('\n AND ');
}

function boundedNonBlankTextCheck(value, maximum = 255) {
  return `(
    typeof(${value}) = 'text'
    AND length(trim(${value}, ${JAVASCRIPT_WHITESPACE_SQL})) > 0
    AND length(CAST(${value} AS BLOB)) <= ${maximum}
  )`;
}

function canonicalTimestampCheck(column, nullable = false) {
  const valid = `(
    typeof(${column}) = 'text'
    AND length(${column}) = 24
    AND ${column} GLOB '${ISO_TIMESTAMP_GLOB}'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', ${column}) = ${column}
  )`;
  return nullable ? `(${column} IS NULL OR ${valid})` : valid;
}

function base64UrlKeyCheck(value, bytes, firstByteIsUncompressedPoint = false) {
  const unpaddedLength = Math.ceil(bytes * 8 / 6);
  const paddingLength = (3 - (bytes % 3)) % 3;
  const unpadded = `rtrim(${value}, '=')`;
  const trailingCharacters = bytes % 3 === 1 ? 'AQgw' : 'AEIMQUYcgkosw048';
  return `(
    typeof(${value}) = 'text'
    AND (
      length(${value}) = ${unpaddedLength}
      OR (
        length(${value}) = ${unpaddedLength + paddingLength}
        AND substr(${value}, -${paddingLength}) = '${'='.repeat(paddingLength)}'
      )
    )
    AND length(${unpadded}) = ${unpaddedLength}
    AND ${unpadded} NOT GLOB '*[^A-Za-z0-9_-]*'
    AND substr(${unpadded}, -1, 1) GLOB '[${trailingCharacters}]'
    ${firstByteIsUncompressedPoint
    ? `AND substr(${unpadded}, 1, 1) = 'B'
      AND substr(${unpadded}, 2, 1) GLOB '[A-P]'`
    : ''}
  )`;
}

function pushEndpointCheck(value, allowLocalhost) {
  const authorityStart = `CASE
    WHEN lower(substr(${value}, 1, 8)) = 'https://' THEN 9
    ELSE 8
  END`;
  const remainder = `substr(${value}, ${authorityStart})`;
  const delimiterPosition = (delimiter) => `CASE
    WHEN instr(${remainder}, '${delimiter}') = 0 THEN length(${remainder}) + 1
    ELSE instr(${remainder}, '${delimiter}')
  END`;
  const authority = `substr(
    ${remainder},
    1,
    min(${delimiterPosition('/')}, ${delimiterPosition('?')}, ${delimiterPosition('#')}) - 1
  )`;
  const colonPosition = `instr(${authority}, ':')`;
  const hostname = `CASE
    WHEN ${colonPosition} = 0 THEN ${authority}
    ELSE substr(${authority}, 1, ${colonPosition} - 1)
  END`;
  const port = `substr(${authority}, ${colonPosition} + 1)`;
  const loopback = `lower(${hostname}) IN ('localhost', '127.0.0.1')`;
  const supportedPublicHost = `(
    lower(${hostname}) IN (${WEB_PUSH_ENDPOINT_HOSTS.map((host) => `'${host}'`).join(', ')})
    ${WEB_PUSH_ENDPOINT_HOST_SUFFIXES.map((suffix) =>
    `OR lower(${hostname}) LIKE '%${suffix}'`).join('\n    ')}
  )`;
  const allowedHost = allowLocalhost
    ? `(${loopback} OR ${supportedPublicHost})`
    : supportedPublicHost;
  const allowedScheme = allowLocalhost
    ? `(
      (lower(substr(${value}, 1, 8)) = 'https://' AND ${allowedHost})
      OR (lower(substr(${value}, 1, 7)) = 'http://' AND ${loopback})
    )`
    : `(lower(substr(${value}, 1, 8)) = 'https://' AND ${supportedPublicHost})`;
  const hostnameShape = allowLocalhost
    ? `(${loopback} OR (
      length(${hostname}) BETWEEN 1 AND 253
      AND ${hostname} NOT GLOB '*[^A-Za-z0-9.-]*'
      AND substr(${hostname}, 1, 1) GLOB '[A-Za-z0-9]'
      AND substr(${hostname}, -1, 1) GLOB '[A-Za-z]'
      AND instr(${hostname}, '.') > 0
    ))`
    : `(
      length(${hostname}) BETWEEN 1 AND 253
      AND ${hostname} NOT GLOB '*[^A-Za-z0-9.-]*'
      AND substr(${hostname}, 1, 1) GLOB '[A-Za-z0-9]'
      AND substr(${hostname}, -1, 1) GLOB '[A-Za-z]'
      AND instr(${hostname}, '.') > 0
    )`;
  const portCheck = allowLocalhost
    ? `(${loopback} OR ${colonPosition} = 0 OR CAST(${port} AS INTEGER) = 443)`
    : `(${colonPosition} = 0 OR CAST(${port} AS INTEGER) = 443)`;

  return `(
    typeof(${value}) = 'text'
    AND ${allowedScheme}
    AND length(${authority}) > 0
    AND length(CAST(${value} AS BLOB)) <= 2048
    AND ${hostnameShape}
    AND instr(${hostname}, '..') = 0
    AND instr(${hostname}, '.-') = 0
    AND instr(${hostname}, '-.') = 0
    AND instr(lower(${hostname}), '.0x') = 0
    AND instr(${authority}, '@') = 0
    AND instr(${authority}, '[') = 0
    AND instr(${authority}, ']') = 0
    AND (
      ${colonPosition} = 0
      OR (
        instr(substr(${authority}, ${colonPosition} + 1), ':') = 0
        AND length(${port}) > 0
        AND ${port} NOT GLOB '*[^0-9]*'
        AND CAST(${port} AS INTEGER) BETWEEN 0 AND 65535
      )
    )
    AND ${portCheck}
    AND instr(${value}, '#') = 0
    AND instr(${value}, char(92)) = 0
    AND ${excludesCodepoints(value, CONTROL_CODEPOINTS)}
  )`;
}

async function dropPreferenceTriggers(knex) {
  for (const name of [
    'notification_preferences_updated_at_managed',
    'notification_preferences_updated_at_not_future',
    'notification_preferences_touch_updated_at',
  ]) {
    await knex.raw(`DROP TRIGGER IF EXISTS ${name}`);
  }
}

async function createPreferenceTriggers(knex) {
  const managedTimestamp = `CASE
    WHEN ${ISO_NOW_SQL} > OLD.updated_at THEN ${ISO_NOW_SQL}
    ELSE strftime('%Y-%m-%dT%H:%M:%fZ', OLD.updated_at, '+0.001 seconds')
  END`;
  await knex.raw(`
    CREATE TRIGGER notification_preferences_updated_at_managed
    BEFORE UPDATE OF updated_at ON notification_preferences
    WHEN NEW.updated_at IS NOT OLD.updated_at
      AND NEW.updated_at IS NOT (${managedTimestamp})
    BEGIN
      SELECT RAISE(ABORT, 'notification_preferences.updated_at is database managed');
    END
  `);
  await knex.raw(`
    CREATE TRIGGER notification_preferences_updated_at_not_future
    BEFORE INSERT ON notification_preferences
    WHEN NEW.updated_at > ${ISO_NOW_SQL}
    BEGIN
      SELECT RAISE(ABORT, 'notification_preferences.updated_at cannot be in the future');
    END
  `);
  await knex.raw(`
    CREATE TRIGGER notification_preferences_touch_updated_at
    AFTER UPDATE OF user_id, notification_kind, inbox_enabled, push_enabled, created_at
    ON notification_preferences
    WHEN NEW.updated_at IS OLD.updated_at
    BEGIN
      UPDATE notification_preferences
      SET updated_at = ${managedTimestamp}
      WHERE user_id = NEW.user_id AND notification_kind = NEW.notification_kind;
    END
  `);
}

async function changePushPreferenceDefault(knex, enabled) {
  await dropPreferenceTriggers(knex);
  await knex.schema.alterTable('notification_preferences', (table) => {
    table.boolean('push_enabled').notNullable().defaultTo(enabled).alter();
  });
  await createPreferenceTriggers(knex);
}

const NOTIFICATION_PREFERENCE_SETTINGS_TRIGGERS = [
  'notification_preference_settings_updated_at_managed',
  'notification_preference_settings_updated_at_not_future',
  'notification_preference_settings_touch_updated_at',
];

async function dropNotificationPreferenceSettingsTriggers(knex) {
  for (const name of NOTIFICATION_PREFERENCE_SETTINGS_TRIGGERS) {
    await knex.raw(`DROP TRIGGER IF EXISTS ${name}`);
  }
}

async function createNotificationPreferenceSettingsTriggers(knex) {
  await dropNotificationPreferenceSettingsTriggers(knex);
  const managedTimestamp = `CASE
    WHEN ${ISO_NOW_SQL} > OLD.updated_at THEN ${ISO_NOW_SQL}
    ELSE strftime('%Y-%m-%dT%H:%M:%fZ', OLD.updated_at, '+0.001 seconds')
  END`;
  await knex.raw(`
    CREATE TRIGGER notification_preference_settings_updated_at_managed
    BEFORE UPDATE OF updated_at ON notification_preference_settings
    WHEN NEW.updated_at IS NOT OLD.updated_at
      AND NEW.updated_at IS NOT (${managedTimestamp})
    BEGIN
      SELECT RAISE(ABORT, 'notification_preference_settings.updated_at is database managed');
    END
  `);
  await knex.raw(`
    CREATE TRIGGER notification_preference_settings_updated_at_not_future
    BEFORE INSERT ON notification_preference_settings
    WHEN NEW.updated_at > ${ISO_NOW_SQL}
    BEGIN
      SELECT RAISE(ABORT, 'notification_preference_settings.updated_at cannot be in the future');
    END
  `);
  await knex.raw(`
    CREATE TRIGGER notification_preference_settings_touch_updated_at
    AFTER UPDATE OF quiet_hours_start, quiet_hours_end, timezone
    ON notification_preference_settings
    WHEN NEW.updated_at IS OLD.updated_at
    BEGIN
      UPDATE notification_preference_settings
      SET updated_at = ${managedTimestamp}
      WHERE user_id = NEW.user_id;
    END
  `);
}

async function createNotificationPreferenceSettings(knex) {
  if (!(await knex.schema.hasTable('notification_preference_settings'))) {
    await knex.schema.createTable('notification_preference_settings', (table) => {
      table.text('user_id').notNullable().primary();
      table.text('quiet_hours_start').nullable();
      table.text('quiet_hours_end').nullable();
      table.text('timezone').notNullable().defaultTo('UTC');
      table.text('created_at').notNullable().defaultTo(knex.raw(`(${ISO_NOW_SQL})`));
      table.text('updated_at').notNullable().defaultTo(knex.raw(`(${ISO_NOW_SQL})`));

      const quietHourCheck = (column) => `(
        ${column} IS NULL OR (
          typeof(${column}) = 'text'
          AND length(${column}) = 5
          AND ${column} GLOB '[0-2][0-9]:[0-5][0-9]'
          AND CAST(substr(${column}, 1, 2) AS INTEGER) BETWEEN 0 AND 23
        )
      )`;
      table.check(
        `${boundedNonBlankTextCheck('user_id')}
          AND ${quietHourCheck('quiet_hours_start')}
          AND ${quietHourCheck('quiet_hours_end')}
          AND ${boundedNonBlankTextCheck('timezone')}`,
        {},
        'notification_preference_settings_values_check'
      );
      table.check(
        'updated_at >= created_at',
        {},
        'notification_preference_settings_temporal_order_check'
      );
      table.check(
        canonicalTimestampCheck('created_at'),
        {},
        'notification_preference_settings_created_at_check'
      );
      table.check(
        canonicalTimestampCheck('updated_at'),
        {},
        'notification_preference_settings_updated_at_check'
      );
    });
  }

  // A prior non-transactional attempt may have created the table and only some
  // triggers. Always converge the trigger set instead of treating the table as
  // proof that the settings schema is complete.
  await createNotificationPreferenceSettingsTriggers(knex);
}

async function dropPushSubscriptionSchemaObjects(knex) {
  for (const name of [
    'push_subscriptions_active_endpoint_idx',
    'push_subscriptions_id_user_idx',
    'push_subscriptions_active_user_idx',
    'push_subscriptions_expiration_idx',
  ]) {
    await knex.raw(`DROP INDEX IF EXISTS ${name}`);
  }
  for (const name of [
    'push_subscriptions_insert_lifecycle_valid',
    'push_subscriptions_version_identity_immutable',
    'push_subscriptions_lifecycle_update_valid',
    'push_subscriptions_preserve_version',
    'push_subscriptions_revoked_keys_guard',
    'push_subscriptions_erase_inserted_revoked_keys',
    'push_subscriptions_erase_revoked_keys',
    'push_subscriptions_updated_at_managed',
    'push_subscriptions_updated_at_not_future',
    'push_subscriptions_touch_updated_at',
    'push_subscriptions_cancel_revoked_jobs',
  ]) {
    await knex.raw(`DROP TRIGGER IF EXISTS ${name}`);
  }
}

async function createPushSubscriptionsTable(knex, allowLocalhost) {
  await knex.raw(`
    CREATE TABLE push_subscriptions (
      subscription_id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      p256dh_key TEXT,
      auth_key TEXT,
      expires_at TEXT,
      user_agent TEXT,
      last_used_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (${ISO_NOW_SQL}),
      updated_at TEXT NOT NULL DEFAULT (${ISO_NOW_SQL}),
      CONSTRAINT push_subscriptions_required_values_check CHECK (
        ${boundedNonBlankTextCheck('subscription_id')}
        AND ${boundedNonBlankTextCheck('user_id')}
        AND ${pushEndpointCheck('endpoint', allowLocalhost)}
        AND (
          (
            ${base64UrlKeyCheck('p256dh_key', 65, true)}
            AND ${base64UrlKeyCheck('auth_key', 16)}
          )
          OR (revoked_at IS NOT NULL AND p256dh_key IS NULL AND auth_key IS NULL)
        )
        AND (
          user_agent IS NULL OR (
            typeof(user_agent) = 'text'
            AND length(CAST(user_agent AS BLOB)) <= 512
          )
        )
      ),
      CONSTRAINT push_subscriptions_temporal_order_check CHECK (
        updated_at >= created_at
        AND (expires_at IS NULL OR expires_at >= created_at)
        AND (last_used_at IS NULL OR last_used_at >= created_at)
        AND (revoked_at IS NULL OR revoked_at >= created_at)
      ),
      CONSTRAINT push_subscriptions_expires_at_check
        CHECK (${canonicalTimestampCheck('expires_at', true)}),
      CONSTRAINT push_subscriptions_last_used_at_check
        CHECK (${canonicalTimestampCheck('last_used_at', true)}),
      CONSTRAINT push_subscriptions_revoked_at_check
        CHECK (${canonicalTimestampCheck('revoked_at', true)}),
      CONSTRAINT push_subscriptions_created_at_check
        CHECK (${canonicalTimestampCheck('created_at')}),
      CONSTRAINT push_subscriptions_updated_at_check
        CHECK (${canonicalTimestampCheck('updated_at')})
    )
  `);
}

async function createPushSubscriptionSchemaObjects(knex, mutable) {
  await knex.raw(`
    CREATE UNIQUE INDEX push_subscriptions_active_endpoint_idx
    ON push_subscriptions (endpoint)
    WHERE revoked_at IS NULL
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX push_subscriptions_id_user_idx
    ON push_subscriptions (subscription_id, user_id)
  `);
  await knex.raw(`
    CREATE INDEX push_subscriptions_active_user_idx
    ON push_subscriptions (user_id, expires_at, subscription_id)
    WHERE revoked_at IS NULL
  `);
  await knex.raw(`
    CREATE INDEX push_subscriptions_expiration_idx
    ON push_subscriptions (expires_at, subscription_id, user_id)
    WHERE revoked_at IS NULL AND expires_at IS NOT NULL
  `);

  const managedTimestamp = `CASE
    WHEN ${ISO_NOW_SQL} > OLD.updated_at THEN ${ISO_NOW_SQL}
    ELSE strftime('%Y-%m-%dT%H:%M:%fZ', OLD.updated_at, '+0.001 seconds')
  END`;
  await knex.raw(`
    CREATE TRIGGER push_subscriptions_insert_lifecycle_valid
    BEFORE INSERT ON push_subscriptions
    WHEN NEW.created_at > ${ISO_NOW_SQL}
      OR NEW.updated_at > ${ISO_NOW_SQL}
      OR (NEW.last_used_at IS NOT NULL AND NEW.last_used_at > NEW.updated_at)
      OR (NEW.revoked_at IS NOT NULL AND NEW.revoked_at > NEW.updated_at)
      OR (
        NEW.revoked_at IS NULL
        AND NEW.expires_at IS NOT NULL
        AND NEW.expires_at <= ${ISO_NOW_SQL}
      )
    BEGIN
      SELECT RAISE(ABORT, 'invalid push subscription lifecycle timestamps');
    END
  `);

  const immutableColumns = mutable
    ? `NEW.subscription_id IS NOT OLD.subscription_id
      OR NEW.user_id IS NOT OLD.user_id
      OR NEW.endpoint IS NOT OLD.endpoint
      OR NEW.created_at IS NOT OLD.created_at`
    : `NEW.subscription_id IS NOT OLD.subscription_id
      OR NEW.user_id IS NOT OLD.user_id
      OR NEW.endpoint IS NOT OLD.endpoint
      OR NEW.expires_at IS NOT OLD.expires_at
      OR NEW.user_agent IS NOT OLD.user_agent
      OR NEW.created_at IS NOT OLD.created_at
      OR (
        (NEW.p256dh_key IS NOT OLD.p256dh_key OR NEW.auth_key IS NOT OLD.auth_key)
        AND NOT (
          OLD.revoked_at IS NOT NULL
          AND NEW.revoked_at IS OLD.revoked_at
          AND NEW.p256dh_key IS NULL
          AND NEW.auth_key IS NULL
        )
      )`;
  await knex.raw(`
    CREATE TRIGGER push_subscriptions_version_identity_immutable
    BEFORE UPDATE ON push_subscriptions
    WHEN ${immutableColumns}
    BEGIN
      SELECT RAISE(ABORT, 'push subscription identity is immutable');
    END
  `);

  const revokedLifecycleCheck = mutable
    ? '0'
    : `(OLD.revoked_at IS NOT NULL AND (
        NEW.revoked_at IS NOT OLD.revoked_at
        OR NEW.last_used_at IS NOT OLD.last_used_at
      ))`;
  await knex.raw(`
    CREATE TRIGGER push_subscriptions_lifecycle_update_valid
    BEFORE UPDATE ON push_subscriptions
    WHEN ${revokedLifecycleCheck}
      OR (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
        AND NEW.last_used_at IS NOT OLD.last_used_at)
      OR (NEW.last_used_at IS NOT NULL AND (
        NEW.last_used_at < NEW.created_at
        OR NEW.last_used_at > (${managedTimestamp})
      ))
      OR (NEW.revoked_at IS NOT NULL AND (
        NEW.revoked_at < NEW.created_at
        OR NEW.revoked_at > (${managedTimestamp})
      ))
      OR (NEW.revoked_at IS NULL AND NEW.expires_at IS NOT NULL
        AND NEW.expires_at <= ${ISO_NOW_SQL})
    BEGIN
      SELECT RAISE(ABORT, 'invalid push subscription lifecycle update');
    END
  `);
  await knex.raw(`
    CREATE TRIGGER push_subscriptions_preserve_version
    BEFORE DELETE ON push_subscriptions
    BEGIN
      SELECT RAISE(ABORT, 'push subscription versions cannot be deleted');
    END
  `);
  await knex.raw(`
    CREATE TRIGGER push_subscriptions_revoked_keys_guard
    BEFORE UPDATE OF p256dh_key, auth_key, revoked_at ON push_subscriptions
    WHEN OLD.revoked_at IS NOT NULL
      AND NEW.revoked_at IS NOT NULL
      AND (NEW.p256dh_key IS NOT NULL OR NEW.auth_key IS NOT NULL)
    BEGIN
      SELECT RAISE(ABORT, 'revoked push subscriptions cannot retain encryption keys');
    END
  `);
  await knex.raw(`
    CREATE TRIGGER push_subscriptions_erase_inserted_revoked_keys
    AFTER INSERT ON push_subscriptions
    WHEN NEW.revoked_at IS NOT NULL
      AND (NEW.p256dh_key IS NOT NULL OR NEW.auth_key IS NOT NULL)
    BEGIN
      UPDATE push_subscriptions
      SET p256dh_key = NULL, auth_key = NULL
      WHERE subscription_id = NEW.subscription_id;
    END
  `);
  await knex.raw(`
    CREATE TRIGGER push_subscriptions_erase_revoked_keys
    AFTER UPDATE OF revoked_at ON push_subscriptions
    WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
    BEGIN
      UPDATE push_subscriptions
      SET p256dh_key = NULL, auth_key = NULL
      WHERE subscription_id = NEW.subscription_id;
    END
  `);
  await knex.raw(`
    CREATE TRIGGER push_subscriptions_updated_at_managed
    BEFORE UPDATE OF updated_at ON push_subscriptions
    WHEN NEW.updated_at IS NOT OLD.updated_at
      AND NEW.updated_at IS NOT (${managedTimestamp})
    BEGIN
      SELECT RAISE(ABORT, 'push_subscriptions.updated_at is database managed');
    END
  `);
  await knex.raw(`
    CREATE TRIGGER push_subscriptions_updated_at_not_future
    BEFORE INSERT ON push_subscriptions
    WHEN NEW.updated_at > ${ISO_NOW_SQL}
    BEGIN
      SELECT RAISE(ABORT, 'push_subscriptions.updated_at cannot be in the future');
    END
  `);
  const touchColumns = mutable
    ? 'p256dh_key, auth_key, expires_at, user_agent, last_used_at, revoked_at'
    : 'last_used_at, revoked_at';
  await knex.raw(`
    CREATE TRIGGER push_subscriptions_touch_updated_at
    AFTER UPDATE OF ${touchColumns} ON push_subscriptions
    WHEN NEW.updated_at IS OLD.updated_at
    BEGIN
      UPDATE push_subscriptions
      SET updated_at = ${managedTimestamp}
      WHERE subscription_id = NEW.subscription_id;
    END
  `);
  await knex.raw(`
    CREATE TRIGGER push_subscriptions_cancel_revoked_jobs
    AFTER UPDATE OF revoked_at ON push_subscriptions
    WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
    BEGIN
      UPDATE push_delivery_jobs
      SET status = 'cancelled',
          next_retry_at = NULL,
          claim_token = NULL,
          claimed_at = NULL,
          lease_expires_at = NULL
      WHERE subscription_id = NEW.subscription_id
        AND (
          status IN ('pending', 'retryable')
          OR (status = 'processing' AND lease_expires_at <= ${ISO_NOW_SQL})
        );
    END
  `);
}

async function rebuildPushSubscriptions(knex, options) {
  const hasLegacyTable = await knex.schema.hasTable('push_subscriptions_legacy');
  if (hasLegacyTable) {
    await knex.raw('PRAGMA legacy_alter_table = ON');
    if (await knex.schema.hasTable('push_subscriptions')) {
      await dropPushSubscriptionSchemaObjects(knex);
      await knex.schema.dropTable('push_subscriptions');
    }
    await knex.schema.renameTable('push_subscriptions_legacy', 'push_subscriptions');
  }
  await dropPushSubscriptionSchemaObjects(knex);
  await knex.raw('PRAGMA legacy_alter_table = ON');
  await knex.schema.renameTable('push_subscriptions', 'push_subscriptions_legacy');
  await createPushSubscriptionsTable(knex, options.allowLocalhost);
  await knex.raw(`
    INSERT INTO push_subscriptions (
      subscription_id, user_id, endpoint, p256dh_key, auth_key, expires_at,
      user_agent, last_used_at, revoked_at, created_at, updated_at
    )
    SELECT
      subscription_id, user_id, endpoint, p256dh_key, auth_key, expires_at,
      user_agent, last_used_at, revoked_at, created_at, updated_at
    FROM push_subscriptions_legacy
  `);
  await knex.schema.dropTable('push_subscriptions_legacy');
  await knex.raw('PRAGMA legacy_alter_table = OFF');
  await createPushSubscriptionSchemaObjects(knex, options.mutable);
}

async function hasLocalhostPushEndpoints(knex) {
  const rows = await knex('push_subscriptions').select('endpoint');
  return rows.some(({ endpoint }) => {
    try {
      const hostname = new URL(endpoint).hostname.toLowerCase();
      return hostname === 'localhost' || hostname === '127.0.0.1';
    } catch {
      return false;
    }
  });
}

async function withForeignKeysDisabled(knex, operation) {
  const connection = await knex.client.acquireConnection();
  const raw = (sql) => knex.raw(sql).connection(connection);
  try {
    const rows = await raw('PRAGMA foreign_keys');
    const foreignKeysEnabled = rows[0]?.foreign_keys === 1;
    if (foreignKeysEnabled) await raw('PRAGMA foreign_keys = OFF');
    try {
      // The explicit connection option pins BEGIN/DDL/COMMIT to the connection
      // whose foreign-key enforcement was disabled. This makes every data and
      // schema change atomic, including trigger creation.
      await knex.transaction(
        async (transaction) => {
          await operation(transaction);
          const violations = await transaction.raw('PRAGMA foreign_key_check');
          if (violations.length > 0) {
            throw new Error(
              'Foreign-key violations detected after rebuilding push subscriptions'
            );
          }
        },
        { connection }
      );
    } finally {
      await raw('PRAGMA legacy_alter_table = OFF');
      if (foreignKeysEnabled) await raw('PRAGMA foreign_keys = ON');
    }
  } finally {
    await knex.client.releaseConnection(connection);
  }
}

export async function up(knex, options = {}) {
  const allowLocalhost = options.allowInsecureLocalhost ?? configuredLocalhostOptIn();
  await withForeignKeysDisabled(knex, async (transaction) => {
    // Existing choices are user data. Only the default for future rows changes.
    await changePushPreferenceDefault(transaction, false);
    await createNotificationPreferenceSettings(transaction);
    await rebuildPushSubscriptions(transaction, {
      allowLocalhost,
      mutable: true,
    });
  });
}

export async function down(knex) {
  await withForeignKeysDisabled(knex, async (transaction) => {
    // Rollback preserves explicitly enrolled localhost rows. When none exist,
    // restore the original public-only CHECK exactly. Older runtimes still reject
    // new localhost registrations at their API validation boundary.
    const allowLocalhost = await hasLocalhostPushEndpoints(transaction);
    await rebuildPushSubscriptions(transaction, {
      allowLocalhost,
      mutable: false,
    });
    await transaction.schema.dropTableIfExists('notification_preference_settings');
    await changePushPreferenceDefault(transaction, true);
  });
}
