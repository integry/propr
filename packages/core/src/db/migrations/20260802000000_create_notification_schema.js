/* eslint-disable max-lines -- this atomic migration documents all cross-table invariants */
/**
 * Create the durable notification schema.
 *
 * Events and delivery attempts are immutable audit records. Recipient state,
 * channel preferences, subscriptions, schedulable delivery jobs, and source
 * activity are stored separately. All timestamps use fixed-width UTC TEXT so
 * lexical indexes retain chronological order.
 *
 * Audit retention is intentionally indefinite. Immutable events, attempts,
 * jobs, and revoked subscription versions may only be archived by a future,
 * explicitly reviewed migration that preserves their referential history.
 */

const ISO_NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const ISO_TIMESTAMP_GLOB = '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z';
const JAVASCRIPT_WHITESPACE_CODEPOINTS = [
  9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197,
  8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279,
];
const CONTROL_CODEPOINTS = [...Array.from({ length: 32 }, (_, index) => index), 127];
// Supported endpoint families are FCM (Chromium), Mozilla Autopush (Firefox),
// and Apple Web Push (Safari). This migration snapshots the allowlist into each
// database CHECK clause. Supporting another vendor hostname requires a later
// schema migration; changing the shared TypeScript constant is not sufficient.
const WEB_PUSH_ENDPOINT_HOSTS = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
];
const WEB_PUSH_ENDPOINT_HOST_SUFFIXES = ['.push.apple.com'];
const PAYLOAD_LIMITS = {
  identifierBytes: 255,
  deduplicationKeyBytes: 512,
  repositoryBytes: 255,
  titleBytes: 256,
  bodyBytes: 4096,
  actionLabelBytes: 128,
  urlBytes: 2048,
  userAgentBytes: 512,
  errorCodeBytes: 128,
  errorMessageBytes: 2048,
  metadataBytes: 16384,
  metadataDepth: 16,
  metadataNodes: 256,
};
const JAVASCRIPT_WHITESPACE_SQL = [
  "' '",
  ...JAVASCRIPT_WHITESPACE_CODEPOINTS
    .filter((codepoint) => codepoint !== 32)
    .map((codepoint) => `char(${codepoint})`),
].join(' || ');

function excludesCodepoints(value, codepoints) {
  return codepoints
    .map((codepoint) => `instr(${value}, char(${codepoint})) = 0`)
    .join('\n  AND ');
}

function nonBlankTextCheck(value) {
  return `(
    typeof(${value}) = 'text'
    AND length(trim(${value}, ${JAVASCRIPT_WHITESPACE_SQL})) > 0
  )`;
}

function utf8ByteLengthCheck(value, maximum) {
  return `length(CAST(${value} AS BLOB)) <= ${maximum}`;
}

function boundedNonBlankTextCheck(value, maximum = PAYLOAD_LIMITS.identifierBytes) {
  return `(${nonBlankTextCheck(value)} AND ${utf8ByteLengthCheck(value, maximum)})`;
}

function boundedTextCheck(value, maximum) {
  return `(typeof(${value}) = 'text' AND ${utf8ByteLengthCheck(value, maximum)})`;
}

function javascriptWhitespaceFreeCheck(value) {
  return excludesCodepoints(value, JAVASCRIPT_WHITESPACE_CODEPOINTS);
}

function safeAbsoluteUrlCheck(
  value,
  {
    httpsOnly = false,
    allowFragment = true,
    allowedHosts,
    allowedHostSuffixes,
    defaultHttpsPortOnly = false,
  } = {}
) {
  const schemeCheck = httpsOnly
    ? `lower(substr(${value}, 1, 8)) = 'https://'`
    : `lower(substr(${value}, 1, 8)) = 'https://'
      OR lower(substr(${value}, 1, 7)) = 'http://'`;
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
    min(
      ${delimiterPosition('/')},
      ${delimiterPosition('?')},
      ${delimiterPosition('#')}
    ) - 1
  )`;
  const colonPosition = `instr(${authority}, ':')`;
  const hostname = `CASE
    WHEN ${colonPosition} = 0 THEN ${authority}
    ELSE substr(${authority}, 1, ${colonPosition} - 1)
  END`;
  const port = `substr(${authority}, ${colonPosition} + 1)`;

  return `(
    (${schemeCheck})
    AND length(${authority}) > 0
    AND ${utf8ByteLengthCheck(value, PAYLOAD_LIMITS.urlBytes)}
    AND length(${hostname}) BETWEEN 1 AND 253
    AND ${hostname} NOT GLOB '*[^A-Za-z0-9.-]*'
    AND substr(${hostname}, 1, 1) GLOB '[A-Za-z0-9]'
    AND substr(${hostname}, -1, 1) GLOB '[A-Za-z]'
    AND (lower(${hostname}) = 'localhost' OR instr(${hostname}, '.') > 0)
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
    AND instr(${value}, char(92)) = 0
    AND ${excludesCodepoints(value, CONTROL_CODEPOINTS)}
    ${allowedHosts === undefined
    ? ''
    : `AND (
      lower(${hostname}) IN (${allowedHosts.map((host) => `'${host}'`).join(', ')})
      ${(allowedHostSuffixes ?? []).map((suffix) =>
    `OR lower(${hostname}) LIKE '%${suffix}'`).join('\n      ')}
    )`}
    ${defaultHttpsPortOnly
    ? `AND (${colonPosition} = 0 OR CAST(${port} AS INTEGER) = 443)`
    : ''}
    ${allowFragment ? '' : `AND instr(${value}, '#') = 0`}
  )`;
}

function base64UrlKeyCheck(
  value,
  { bytes, firstByteIsUncompressedPoint = false }
) {
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

function jsonHasDuplicateKeys(value) {
  return `EXISTS (
    SELECT 1
    FROM json_tree(${value})
    WHERE parent IS NOT NULL
    GROUP BY parent, key
    HAVING count(*) > 1
  )`;
}

function jsonObjectOnlyHasKeys(value, keys) {
  return `json_remove(
    ${value},
    ${keys.map((key) => `'$.${key}'`).join(', ')}
  ) = '{}'`;
}

function jsonDepthExceeds(value, maximumDepth) {
  return `EXISTS (
    WITH RECURSIVE json_depth(id, depth) AS (
      SELECT id, 0
      FROM json_tree(${value})
      WHERE parent IS NULL
      UNION ALL
      SELECT child.id, parent.depth + 1
      FROM json_tree(${value}) AS child
      JOIN json_depth AS parent ON child.parent = parent.id
    )
    SELECT 1 FROM json_depth WHERE depth > ${maximumDepth}
  )`;
}

const JSON_REPOSITORY = "json_extract(target_json, '$.repository')";
function repositoryCheck(value) {
  return `
  ${nonBlankTextCheck(value)}
  AND ${utf8ByteLengthCheck(value, PAYLOAD_LIMITS.repositoryBytes)}
  AND ${javascriptWhitespaceFreeCheck(value)}
  AND instr(${value}, '/') > 1
  AND length(substr(
    ${value},
    instr(${value}, '/') + 1
  )) > 0
  AND instr(substr(
    ${value},
    instr(${value}, '/') + 1
  ), '/') = 0
`;
}

const JSON_REPOSITORY_TARGET_CHECK = `
  json_type(target_json, '$.repository') = 'text'
  AND ${repositoryCheck(JSON_REPOSITORY)}
`;

const isoNow = (knex) => knex.raw(`(${ISO_NOW_SQL})`);

function canonicalTimestampCheck(column, nullable = false) {
  const valid = `(
    typeof(${column}) = 'text'
    AND length(${column}) = 24
    AND ${column} GLOB '${ISO_TIMESTAMP_GLOB}'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', ${column}) = ${column}
  )`;
  return nullable ? `(${column} IS NULL OR ${valid})` : valid;
}

function addTimestampCheck(table, column, constraintName, nullable = false) {
  table.check(
    canonicalTimestampCheck(column, nullable),
    {},
    constraintName
  );
}

async function createUpdatedAtTrigger(
  knex,
  tableName,
  keyPredicate,
  mutableColumns
) {
  const managedTimestamp = `CASE
    WHEN ${ISO_NOW_SQL} > OLD.updated_at THEN ${ISO_NOW_SQL}
    ELSE strftime('%Y-%m-%dT%H:%M:%fZ', OLD.updated_at, '+0.001 seconds')
  END`;
  await knex.raw(`
    CREATE TRIGGER ${tableName}_updated_at_managed
    BEFORE UPDATE OF updated_at ON ${tableName}
    WHEN NEW.updated_at IS NOT OLD.updated_at
      AND NEW.updated_at IS NOT (${managedTimestamp})
    BEGIN
      SELECT RAISE(ABORT, '${tableName}.updated_at is database managed');
    END
  `);
  await knex.raw(`
    CREATE TRIGGER ${tableName}_updated_at_not_future
    BEFORE INSERT ON ${tableName}
    WHEN NEW.updated_at > ${ISO_NOW_SQL}
    BEGIN
      SELECT RAISE(ABORT, '${tableName}.updated_at cannot be in the future');
    END
  `);
  await knex.raw(`
    CREATE TRIGGER ${tableName}_touch_updated_at
    AFTER UPDATE OF ${mutableColumns.join(', ')} ON ${tableName}
    WHEN NEW.updated_at IS OLD.updated_at
    BEGIN
      UPDATE ${tableName}
      SET updated_at = ${managedTimestamp}
      WHERE ${keyPredicate};
    END
  `);
}

export async function up(knex) {
  await knex.schema.createTable('notification_events', (table) => {
    table.text('event_id').notNullable().primary();
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
      `${boundedNonBlankTextCheck('event_id')}
        AND ${boundedNonBlankTextCheck(
          'deduplication_key',
          PAYLOAD_LIMITS.deduplicationKeyBytes
        )}
        AND ${boundedNonBlankTextCheck('title', PAYLOAD_LIMITS.titleBytes)}
        AND ${boundedTextCheck('body', PAYLOAD_LIMITS.bodyBytes)}`,
      {},
      'notification_events_required_text_check'
    );
    table.check(
      `CASE WHEN typeof(target_json) = 'text' AND json_valid(target_json)
        THEN COALESCE(
          json_type(target_json) = 'object'
          AND ${utf8ByteLengthCheck('target_json', PAYLOAD_LIMITS.metadataBytes)},
          0
        )
        ELSE 0
      END`,
      {},
      'notification_events_target_json_check'
    );
    table.check(
      "CASE WHEN json_valid(target_json) THEN COALESCE(json_extract(target_json, '$.type') = kind, 0) ELSE 0 END",
      {},
      'notification_events_target_kind_check'
    );
    table.check(
      `CASE
        WHEN NOT json_valid(target_json) OR json_type(target_json) != 'object' THEN 0
        WHEN kind = 'plan' THEN COALESCE(
          ${jsonObjectOnlyHasKeys('target_json', ['type', 'repository', 'draftId'])}
          AND ${JSON_REPOSITORY_TARGET_CHECK}
          AND json_type(target_json, '$.draftId') = 'text'
          AND ${boundedNonBlankTextCheck("json_extract(target_json, '$.draftId')")},
          0
        )
        WHEN kind = 'task' THEN COALESCE(
          ${jsonObjectOnlyHasKeys(
            'target_json',
            ['type', 'repository', 'taskId', 'issueNumber', 'prNumber']
          )}
          AND ${JSON_REPOSITORY_TARGET_CHECK}
          AND json_type(target_json, '$.taskId') = 'text'
          AND ${boundedNonBlankTextCheck("json_extract(target_json, '$.taskId')")}
          AND (json_type(target_json, '$.issueNumber') IS NULL OR (
            json_type(target_json, '$.issueNumber') = 'integer'
            AND json_extract(target_json, '$.issueNumber') > 0
            AND json_extract(target_json, '$.issueNumber') <= 9007199254740991
          ))
          AND (json_type(target_json, '$.prNumber') IS NULL OR (
            json_type(target_json, '$.prNumber') = 'integer'
            AND json_extract(target_json, '$.prNumber') > 0
            AND json_extract(target_json, '$.prNumber') <= 9007199254740991
          )),
          0
        )
        WHEN kind = 'review' THEN COALESCE(
          ${jsonObjectOnlyHasKeys(
            'target_json',
            ['type', 'repository', 'prNumber', 'taskId']
          )}
          AND ${JSON_REPOSITORY_TARGET_CHECK}
          AND json_type(target_json, '$.prNumber') = 'integer'
          AND json_extract(target_json, '$.prNumber') > 0
          AND json_extract(target_json, '$.prNumber') <= 9007199254740991
          AND (json_type(target_json, '$.taskId') IS NULL OR (
            json_type(target_json, '$.taskId') = 'text'
            AND ${boundedNonBlankTextCheck("json_extract(target_json, '$.taskId')")}
          )),
          0
        )
        WHEN kind = 'pull_request' THEN COALESCE(
          ${jsonObjectOnlyHasKeys(
            'target_json',
            ['type', 'repository', 'prNumber']
          )}
          AND ${JSON_REPOSITORY_TARGET_CHECK}
          AND json_type(target_json, '$.prNumber') = 'integer'
          AND json_extract(target_json, '$.prNumber') > 0
          AND json_extract(target_json, '$.prNumber') <= 9007199254740991,
          0
        )
        WHEN kind = 'indexing' THEN COALESCE(
          ${jsonObjectOnlyHasKeys(
            'target_json',
            ['type', 'repository', 'branch']
          )}
          AND ${JSON_REPOSITORY_TARGET_CHECK}
          AND (json_type(target_json, '$.branch') IS NULL OR (
            json_type(target_json, '$.branch') = 'text'
            AND ${boundedNonBlankTextCheck("json_extract(target_json, '$.branch')")}
          )),
          0
        )
        WHEN kind = 'system_failure' THEN COALESCE(
          ${jsonObjectOnlyHasKeys(
            'target_json',
            ['type', 'component', 'correlationId']
          )}
          AND json_type(target_json, '$.component') = 'text'
          AND ${boundedNonBlankTextCheck("json_extract(target_json, '$.component')")}
          AND (json_type(target_json, '$.correlationId') IS NULL OR (
            json_type(target_json, '$.correlationId') = 'text'
            AND ${boundedNonBlankTextCheck("json_extract(target_json, '$.correlationId')")}
          )),
          0
        )
        ELSE 0
      END`,
      {},
      'notification_events_target_contract_check'
    );
    table.check(
      `CASE
        WHEN action_json IS NULL THEN 1
        WHEN NOT json_valid(action_json) OR json_type(action_json) != 'object' THEN 0
        ELSE COALESCE(
          ${jsonObjectOnlyHasKeys('action_json', ['type', 'label', 'href'])}
          AND json_type(action_json, '$.label') = 'text'
          AND ${boundedNonBlankTextCheck(
            "json_extract(action_json, '$.label')",
            PAYLOAD_LIMITS.actionLabelBytes
          )}
          AND json_type(action_json, '$.href') = 'text'
          AND ${boundedNonBlankTextCheck(
            "json_extract(action_json, '$.href')",
            PAYLOAD_LIMITS.urlBytes
          )}
          AND CASE json_extract(action_json, '$.type')
            WHEN 'navigate' THEN
              substr(json_extract(action_json, '$.href'), 1, 1) = '/'
              AND substr(json_extract(action_json, '$.href'), 1, 2) != '//'
              AND instr(json_extract(action_json, '$.href'), char(92)) = 0
              AND ${excludesCodepoints(
                "json_extract(action_json, '$.href')",
                CONTROL_CODEPOINTS
              )}
            WHEN 'external_link' THEN ${safeAbsoluteUrlCheck(
              "json_extract(action_json, '$.href')"
            )}
            ELSE 0
          END,
          0
        )
      END`,
      {},
      'notification_events_action_json_check'
    );
    table.check(
      `CASE
        WHEN metadata_json IS NULL THEN 1
        WHEN typeof(metadata_json) = 'text' AND json_valid(metadata_json) THEN COALESCE(
          json_type(metadata_json) = 'object'
          AND ${utf8ByteLengthCheck('metadata_json', PAYLOAD_LIMITS.metadataBytes)},
          0
        )
        ELSE 0
      END`,
      {},
      'notification_events_metadata_json_check'
    );
    addTimestampCheck(
      table,
      'occurred_at',
      'notification_events_occurred_at_check'
    );
    addTimestampCheck(
      table,
      'created_at',
      'notification_events_created_at_check'
    );
    table.check(
      'created_at >= occurred_at',
      {},
      'notification_events_temporal_order_check'
    );
  });

  await knex.raw(
    'CREATE UNIQUE INDEX notification_events_deduplication_key_idx ON notification_events (deduplication_key)'
  );
  await knex.raw(
    'CREATE INDEX notification_events_occurred_at_idx ON notification_events (occurred_at DESC, event_id)'
  );

  await knex.raw(`
    CREATE TRIGGER notification_events_created_at_not_future
    BEFORE INSERT ON notification_events
    WHEN NEW.created_at > ${ISO_NOW_SQL}
    BEGIN
      SELECT RAISE(ABORT, 'notification event creation time cannot be in the future');
    END
  `);
  await knex.raw(`
    CREATE TRIGGER notification_events_json_keys_unique
    BEFORE INSERT ON notification_events
    WHEN CASE
      WHEN json_valid(NEW.target_json) AND ${jsonHasDuplicateKeys('NEW.target_json')}
        THEN 1
      WHEN NEW.action_json IS NOT NULL
        AND json_valid(NEW.action_json)
        AND ${jsonHasDuplicateKeys('NEW.action_json')}
        THEN 1
      WHEN NEW.metadata_json IS NOT NULL
        AND json_valid(NEW.metadata_json)
        AND ${jsonHasDuplicateKeys('NEW.metadata_json')}
        THEN 1
      ELSE 0
    END
    BEGIN
      SELECT RAISE(ABORT, 'notification JSON must not contain duplicate object keys');
    END
  `);
  await knex.raw(`
    CREATE TRIGGER notification_events_metadata_structure_limited
    BEFORE INSERT ON notification_events
    WHEN NEW.metadata_json IS NOT NULL
      AND json_valid(NEW.metadata_json)
      AND (
        (SELECT count(*) FROM json_tree(NEW.metadata_json)) > ${PAYLOAD_LIMITS.metadataNodes}
        OR ${jsonDepthExceeds('NEW.metadata_json', PAYLOAD_LIMITS.metadataDepth)}
      )
    BEGIN
      SELECT RAISE(ABORT, 'notification metadata exceeds structural limits');
    END
  `);
  await knex.raw(`
    CREATE TRIGGER notification_events_metadata_numbers_finite
    BEFORE INSERT ON notification_events
    WHEN NEW.metadata_json IS NOT NULL
      AND json_valid(NEW.metadata_json)
      AND EXISTS (
        SELECT 1
        FROM json_tree(NEW.metadata_json)
        WHERE type IN ('integer', 'real')
          AND NOT (abs(atom) <= 1.7976931348623157e308)
      )
    BEGIN
      SELECT RAISE(ABORT, 'notification metadata numbers must be finite');
    END
  `);

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
    table.boolean('inbox_enabled').notNullable().defaultTo(true);
    table.boolean('push_enabled').notNullable().defaultTo(true);
    table.text('read_at').nullable();
    table.text('dismissed_at').nullable();
    table.text('created_at').notNullable().defaultTo(isoNow(knex));

    table.primary(['event_id', 'user_id']);
    table.check(
      `${boundedNonBlankTextCheck('event_id')}
        AND ${boundedNonBlankTextCheck('user_id')}`,
      {},
      'notification_user_states_identifiers_check'
    );
    table.check(
      'inbox_enabled IN (0, 1) AND push_enabled IN (0, 1)',
      {},
      'notification_user_states_channels_boolean_check'
    );
    table.check(
      'inbox_enabled = 1 OR (read_at IS NULL AND dismissed_at IS NULL)',
      {},
      'notification_user_states_inbox_state_check'
    );
    table.check(
      'inbox_enabled = 1 OR push_enabled = 1',
      {},
      'notification_user_states_channel_required_check'
    );
    table.check(
      '(read_at IS NULL OR read_at >= created_at) AND (dismissed_at IS NULL OR dismissed_at >= created_at)',
      {},
      'notification_user_states_temporal_order_check'
    );
    addTimestampCheck(
      table,
      'read_at',
      'notification_user_states_read_at_check',
      true
    );
    addTimestampCheck(
      table,
      'dismissed_at',
      'notification_user_states_dismissed_at_check',
      true
    );
    addTimestampCheck(
      table,
      'created_at',
      'notification_user_states_created_at_check'
    );

    table
      .foreign('event_id')
      .references('event_id')
      .inTable('notification_events')
      .onUpdate('RESTRICT')
      .onDelete('RESTRICT');
  });

  await knex.raw(`
    CREATE TRIGGER notification_user_states_assignment_time_valid
    BEFORE INSERT ON notification_user_states
    WHEN NEW.created_at > ${ISO_NOW_SQL}
      OR EXISTS (
        SELECT 1
        FROM notification_events AS event
        WHERE event.event_id = NEW.event_id
          AND NEW.created_at < event.created_at
      )
    BEGIN
      SELECT RAISE(ABORT, 'notification recipient assignment must follow event creation');
    END
  `);
  await knex.raw(`
    CREATE TRIGGER notification_user_states_inbox_times_not_future_insert
    BEFORE INSERT ON notification_user_states
    WHEN (NEW.read_at IS NOT NULL AND NEW.read_at > ${ISO_NOW_SQL})
      OR (NEW.dismissed_at IS NOT NULL AND NEW.dismissed_at > ${ISO_NOW_SQL})
    BEGIN
      SELECT RAISE(ABORT, 'notification Inbox state timestamps cannot be in the future');
    END
  `);
  await knex.raw(`
    CREATE TRIGGER notification_user_states_inbox_times_not_future_update
    BEFORE UPDATE OF read_at, dismissed_at ON notification_user_states
    WHEN (NEW.read_at IS NOT NULL AND NEW.read_at > ${ISO_NOW_SQL})
      OR (NEW.dismissed_at IS NOT NULL AND NEW.dismissed_at > ${ISO_NOW_SQL})
    BEGIN
      SELECT RAISE(ABORT, 'notification Inbox state timestamps cannot be in the future');
    END
  `);
  await knex.raw(`
    CREATE TRIGGER notification_user_states_assignment_immutable
    BEFORE UPDATE ON notification_user_states
    WHEN NEW.event_id IS NOT OLD.event_id
      OR NEW.user_id IS NOT OLD.user_id
      OR NEW.inbox_enabled IS NOT OLD.inbox_enabled
      OR NEW.push_enabled IS NOT OLD.push_enabled
      OR NEW.created_at IS NOT OLD.created_at
    BEGIN
      SELECT RAISE(ABORT, 'notification recipient assignment is immutable');
    END
  `);

  await knex.raw(`
    CREATE INDEX notification_user_states_visible_idx
    ON notification_user_states (user_id, created_at DESC, event_id DESC)
    WHERE inbox_enabled = 1 AND dismissed_at IS NULL
  `);
  await knex.raw(`
    CREATE INDEX notification_user_states_unread_idx
    ON notification_user_states (user_id, created_at DESC, event_id DESC)
    WHERE inbox_enabled = 1 AND read_at IS NULL AND dismissed_at IS NULL
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
      boundedNonBlankTextCheck('user_id'),
      {},
      'notification_preferences_user_id_check'
    );
    table.check(
      "notification_kind IN ('plan', 'task', 'review', 'pull_request', 'indexing', 'system_failure')",
      {},
      'notification_preferences_kind_check'
    );
    table.check(
      'inbox_enabled IN (0, 1)',
      {},
      'notification_preferences_inbox_boolean_check'
    );
    table.check(
      'push_enabled IN (0, 1)',
      {},
      'notification_preferences_push_boolean_check'
    );
    table.check(
      'updated_at >= created_at',
      {},
      'notification_preferences_temporal_order_check'
    );
    addTimestampCheck(
      table,
      'created_at',
      'notification_preferences_created_at_check'
    );
    addTimestampCheck(
      table,
      'updated_at',
      'notification_preferences_updated_at_check'
    );
  });
  await createUpdatedAtTrigger(
    knex,
    'notification_preferences',
    'user_id = NEW.user_id AND notification_kind = NEW.notification_kind',
    [
      'user_id',
      'notification_kind',
      'inbox_enabled',
      'push_enabled',
      'created_at',
    ]
  );

  await knex.schema.createTable('push_subscriptions', (table) => {
    table.text('subscription_id').notNullable().primary();
    table.text('user_id').notNullable();
    table.text('endpoint').notNullable();
    // Active versions retain delivery material. Revocation erases both secrets
    // while preserving the immutable endpoint/version identity for audit rows.
    table.text('p256dh_key').nullable();
    table.text('auth_key').nullable();
    table.text('expires_at').nullable();
    table.text('user_agent').nullable();
    table.text('last_used_at').nullable();
    table.text('revoked_at').nullable();
    table.text('created_at').notNullable().defaultTo(isoNow(knex));
    table.text('updated_at').notNullable().defaultTo(isoNow(knex));

    table.check(
      `${boundedNonBlankTextCheck('subscription_id')}
        AND ${boundedNonBlankTextCheck('user_id')}
        AND ${safeAbsoluteUrlCheck('endpoint', {
          httpsOnly: true,
          allowFragment: false,
          allowedHosts: WEB_PUSH_ENDPOINT_HOSTS,
          allowedHostSuffixes: WEB_PUSH_ENDPOINT_HOST_SUFFIXES,
          defaultHttpsPortOnly: true,
        })}
        AND (
          (
            ${base64UrlKeyCheck('p256dh_key', {
              bytes: 65,
              firstByteIsUncompressedPoint: true,
            })}
            AND ${base64UrlKeyCheck('auth_key', { bytes: 16 })}
          )
          OR (revoked_at IS NOT NULL AND p256dh_key IS NULL AND auth_key IS NULL)
        )
        AND (user_agent IS NULL OR ${boundedTextCheck(
          'user_agent',
          PAYLOAD_LIMITS.userAgentBytes
        )})`,
      {},
      'push_subscriptions_required_values_check'
    );
    table.check(
      `updated_at >= created_at
        AND (expires_at IS NULL OR expires_at >= created_at)
        AND (last_used_at IS NULL OR last_used_at >= created_at)
        AND (revoked_at IS NULL OR revoked_at >= created_at)`,
      {},
      'push_subscriptions_temporal_order_check'
    );
    addTimestampCheck(
      table,
      'expires_at',
      'push_subscriptions_expires_at_check',
      true
    );
    addTimestampCheck(
      table,
      'last_used_at',
      'push_subscriptions_last_used_at_check',
      true
    );
    addTimestampCheck(
      table,
      'revoked_at',
      'push_subscriptions_revoked_at_check',
      true
    );
    addTimestampCheck(
      table,
      'created_at',
      'push_subscriptions_created_at_check'
    );
    addTimestampCheck(
      table,
      'updated_at',
      'push_subscriptions_updated_at_check'
    );
  });

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

  const subscriptionManagedTimestamp = `CASE
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
  await knex.raw(`
    CREATE TRIGGER push_subscriptions_version_identity_immutable
    BEFORE UPDATE ON push_subscriptions
    WHEN NEW.subscription_id IS NOT OLD.subscription_id
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
      )
    BEGIN
      SELECT RAISE(ABORT, 'push subscription versions are immutable');
    END
  `);
  await knex.raw(`
    CREATE TRIGGER push_subscriptions_lifecycle_update_valid
    BEFORE UPDATE ON push_subscriptions
    WHEN (OLD.revoked_at IS NOT NULL AND (
        NEW.revoked_at IS NOT OLD.revoked_at
        OR NEW.last_used_at IS NOT OLD.last_used_at
      ))
      OR (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
        AND NEW.last_used_at IS NOT OLD.last_used_at)
      OR (NEW.last_used_at IS NOT NULL AND (
        NEW.last_used_at < NEW.created_at
        OR NEW.last_used_at > (${subscriptionManagedTimestamp})
      ))
      OR (NEW.revoked_at IS NOT NULL AND (
        NEW.revoked_at < NEW.created_at
        OR NEW.revoked_at > (${subscriptionManagedTimestamp})
      ))
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
    CREATE TRIGGER push_subscriptions_erase_inserted_revoked_keys
    AFTER INSERT ON push_subscriptions
    WHEN NEW.revoked_at IS NOT NULL
      AND (NEW.p256dh_key IS NOT NULL OR NEW.auth_key IS NOT NULL)
    BEGIN
      UPDATE push_subscriptions
      SET p256dh_key = NULL,
          auth_key = NULL
      WHERE subscription_id = NEW.subscription_id;
    END
  `);
  await knex.raw(`
    CREATE TRIGGER push_subscriptions_erase_revoked_keys
    AFTER UPDATE OF revoked_at ON push_subscriptions
    WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
    BEGIN
      UPDATE push_subscriptions
      SET p256dh_key = NULL,
          auth_key = NULL
      WHERE subscription_id = NEW.subscription_id;
    END
  `);
  await createUpdatedAtTrigger(
    knex,
    'push_subscriptions',
    'subscription_id = NEW.subscription_id',
    ['last_used_at', 'revoked_at']
  );

  // Delivery jobs are mutable scheduling state. Actual Web Push requests are
  // inserted into the immutable attempts table below.
  await knex.schema.createTable('push_delivery_jobs', (table) => {
    table.text('job_id').notNullable().primary();
    table.text('deduplication_key').notNullable();
    table.text('event_id').notNullable();
    table.text('user_id').notNullable();
    table.text('subscription_id').notNullable();
    table.integer('attempt_count').notNullable().defaultTo(0);
    table.text('status').notNullable().defaultTo('pending');
    table.text('next_retry_at').nullable();
    table.text('claim_token').nullable();
    table.text('claimed_at').nullable();
    table.text('lease_expires_at').nullable();
    table.text('created_at').notNullable().defaultTo(isoNow(knex));
    table.text('updated_at').notNullable().defaultTo(isoNow(knex));

    table.check(
      "status IN ('pending', 'processing', 'retryable', 'delivered', 'failed', 'cancelled')",
      {},
      'push_delivery_jobs_status_check'
    );
    table.check(
      "typeof(attempt_count) = 'integer' AND attempt_count BETWEEN 0 AND 9007199254740991",
      {},
      'push_delivery_jobs_attempt_count_check'
    );
    table.check(
      `${boundedNonBlankTextCheck('job_id')}
        AND ${boundedNonBlankTextCheck(
          'deduplication_key',
          PAYLOAD_LIMITS.deduplicationKeyBytes
        )}
        AND ${boundedNonBlankTextCheck('event_id')}
        AND ${boundedNonBlankTextCheck('user_id')}
        AND ${boundedNonBlankTextCheck('subscription_id')}`,
      {},
      'push_delivery_jobs_identifiers_check'
    );
    table.check(
      `COALESCE(((
        status = 'pending'
        AND next_retry_at IS NULL
        AND claim_token IS NULL
        AND claimed_at IS NULL
        AND lease_expires_at IS NULL
      ) OR (
        status = 'processing'
        AND next_retry_at IS NULL
        AND ${boundedNonBlankTextCheck('claim_token')}
        AND claimed_at IS NOT NULL
        AND lease_expires_at IS NOT NULL
        AND claimed_at >= created_at
        AND lease_expires_at > claimed_at
      ) OR (
        status = 'retryable'
        AND attempt_count > 0
        AND next_retry_at IS NOT NULL
        AND claim_token IS NULL
        AND claimed_at IS NULL
        AND lease_expires_at IS NULL
      ) OR (
        status IN ('delivered', 'failed', 'cancelled')
        AND (status = 'cancelled' OR attempt_count > 0)
        AND next_retry_at IS NULL
        AND claim_token IS NULL
        AND claimed_at IS NULL
        AND lease_expires_at IS NULL
      )), 0)`,
      {},
      'push_delivery_jobs_state_check'
    );
    table.check(
      'updated_at >= created_at',
      {},
      'push_delivery_jobs_temporal_order_check'
    );
    addTimestampCheck(
      table,
      'next_retry_at',
      'push_delivery_jobs_next_retry_at_check',
      true
    );
    addTimestampCheck(
      table,
      'claimed_at',
      'push_delivery_jobs_claimed_at_check',
      true
    );
    addTimestampCheck(
      table,
      'lease_expires_at',
      'push_delivery_jobs_lease_expires_at_check',
      true
    );
    addTimestampCheck(
      table,
      'created_at',
      'push_delivery_jobs_created_at_check'
    );
    addTimestampCheck(
      table,
      'updated_at',
      'push_delivery_jobs_updated_at_check'
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
    'CREATE UNIQUE INDEX push_delivery_jobs_deduplication_key_idx ON push_delivery_jobs (deduplication_key)'
  );
  await knex.raw(`
    CREATE UNIQUE INDEX push_delivery_jobs_event_subscription_idx
    ON push_delivery_jobs (event_id, subscription_id)
  `);
  await knex.raw(`
    CREATE INDEX push_delivery_jobs_subscription_user_idx
    ON push_delivery_jobs (subscription_id, user_id)
  `);
  await knex.raw(`
    CREATE INDEX push_delivery_jobs_pending_idx
    ON push_delivery_jobs (created_at, job_id)
    WHERE status = 'pending'
  `);
  await knex.raw(`
    CREATE INDEX push_delivery_jobs_retry_idx
    ON push_delivery_jobs (next_retry_at, job_id)
    WHERE status = 'retryable' AND next_retry_at IS NOT NULL
  `);
  await knex.raw(`
    CREATE INDEX push_delivery_jobs_processing_lease_idx
    ON push_delivery_jobs (lease_expires_at, job_id)
    WHERE status = 'processing' AND lease_expires_at IS NOT NULL
  `);

  await knex.raw(`
    CREATE TRIGGER push_delivery_jobs_insert_pending_only
    BEFORE INSERT ON push_delivery_jobs
    WHEN NEW.status != 'pending' OR NEW.attempt_count != 0
    BEGIN
      SELECT RAISE(ABORT, 'push delivery jobs must start pending');
    END
  `);
  await knex.raw(`
    CREATE TRIGGER push_delivery_jobs_insert_eligibility
    BEFORE INSERT ON push_delivery_jobs
    WHEN NOT EXISTS (
      SELECT 1
      FROM notification_user_states AS recipient
      JOIN push_subscriptions AS subscription
        ON subscription.subscription_id = NEW.subscription_id
        AND subscription.user_id = NEW.user_id
      WHERE recipient.event_id = NEW.event_id
        AND recipient.user_id = NEW.user_id
        AND recipient.push_enabled = 1
        AND recipient.created_at <= NEW.created_at
        AND subscription.created_at <= NEW.created_at
        AND subscription.revoked_at IS NULL
        AND (subscription.expires_at IS NULL OR subscription.expires_at > ${ISO_NOW_SQL})
    )
      OR NEW.created_at > ${ISO_NOW_SQL}
    BEGIN
      SELECT RAISE(ABORT, 'push delivery requires an eligible recipient and active subscription');
    END
  `);
  await knex.raw(`
    CREATE TRIGGER push_delivery_jobs_identity_immutable
    BEFORE UPDATE ON push_delivery_jobs
    WHEN NEW.job_id IS NOT OLD.job_id
      OR NEW.deduplication_key IS NOT OLD.deduplication_key
      OR NEW.event_id IS NOT OLD.event_id
      OR NEW.user_id IS NOT OLD.user_id
      OR NEW.subscription_id IS NOT OLD.subscription_id
      OR NEW.created_at IS NOT OLD.created_at
    BEGIN
      SELECT RAISE(ABORT, 'push delivery job identity is immutable');
    END
  `);
  await knex.raw(`
    CREATE TRIGGER push_delivery_jobs_immutable_delete
    BEFORE DELETE ON push_delivery_jobs
    BEGIN
      SELECT RAISE(ABORT, 'push delivery jobs cannot be deleted');
    END
  `);

  await knex.schema.createTable('push_delivery_attempts', (table) => {
    table.text('attempt_id').notNullable().primary();
    table.text('job_id').notNullable();
    table.integer('attempt_number').notNullable();
    table.text('status').notNullable();
    table.integer('response_status').nullable();
    table.text('error_code').nullable();
    table.text('error_message').nullable();
    table.text('attempted_at').notNullable();
    table.text('next_retry_at').nullable();
    table.text('claim_token').notNullable();
    table.text('created_at').notNullable().defaultTo(isoNow(knex));

    table.check(
      "status IN ('delivered', 'retryable', 'failed')",
      {},
      'push_delivery_attempts_status_check'
    );
    table.check(
      "typeof(attempt_number) = 'integer' AND attempt_number > 0 AND attempt_number <= 9007199254740991",
      {},
      'push_delivery_attempts_number_check'
    );
    table.check(
      `${boundedNonBlankTextCheck('attempt_id')}
        AND ${boundedNonBlankTextCheck('job_id')}
        AND ${boundedNonBlankTextCheck('claim_token')}
        AND (error_code IS NULL OR ${boundedNonBlankTextCheck(
          'error_code',
          PAYLOAD_LIMITS.errorCodeBytes
        )})
        AND (error_message IS NULL OR ${boundedTextCheck(
          'error_message',
          PAYLOAD_LIMITS.errorMessageBytes
        )})`,
      {},
      'push_delivery_attempts_text_values_check'
    );
    table.check(
      "response_status IS NULL OR (typeof(response_status) = 'integer' AND response_status BETWEEN 100 AND 599)",
      {},
      'push_delivery_attempts_response_status_check'
    );
    table.check(
      `COALESCE(((
        status = 'delivered'
        AND response_status BETWEEN 200 AND 299
        AND error_code IS NULL
        AND error_message IS NULL
        AND next_retry_at IS NULL
      ) OR (
        status = 'retryable'
        AND (response_status IS NOT NULL OR ${nonBlankTextCheck('error_code')})
        AND (response_status IS NULL OR response_status NOT BETWEEN 200 AND 299)
        AND next_retry_at IS NOT NULL
        AND next_retry_at > attempted_at
      ) OR (
        status = 'failed'
        AND (response_status IS NOT NULL OR ${nonBlankTextCheck('error_code')})
        AND (response_status IS NULL OR response_status NOT BETWEEN 200 AND 299)
        AND next_retry_at IS NULL
      )), 0)`,
      {},
      'push_delivery_attempts_outcome_check'
    );
    table.check(
      'created_at >= attempted_at',
      {},
      'push_delivery_attempts_temporal_order_check'
    );
    addTimestampCheck(
      table,
      'attempted_at',
      'push_delivery_attempts_attempted_at_check'
    );
    addTimestampCheck(
      table,
      'next_retry_at',
      'push_delivery_attempts_next_retry_at_check',
      true
    );
    addTimestampCheck(
      table,
      'created_at',
      'push_delivery_attempts_created_at_check'
    );

    table
      .foreign('job_id')
      .references('job_id')
      .inTable('push_delivery_jobs')
      .onUpdate('RESTRICT')
      .onDelete('RESTRICT');
  });

  await knex.raw(`
    CREATE UNIQUE INDEX push_delivery_attempts_job_attempt_idx
    ON push_delivery_attempts (job_id, attempt_number)
  `);
  await knex.raw(`
    CREATE TRIGGER push_delivery_attempts_created_at_not_future
    BEFORE INSERT ON push_delivery_attempts
    WHEN NEW.created_at > ${ISO_NOW_SQL}
    BEGIN
      SELECT RAISE(ABORT, 'push delivery attempt creation time cannot be in the future');
    END
  `);
  await knex.raw(`
    CREATE TRIGGER push_delivery_attempts_valid_claim
    BEFORE INSERT ON push_delivery_attempts
    WHEN NOT EXISTS (
      SELECT 1
      FROM push_delivery_jobs AS job
      WHERE job.job_id = NEW.job_id
        AND job.status = 'processing'
        AND job.claim_token = NEW.claim_token
        AND NEW.attempt_number = job.attempt_count + 1
        AND NEW.attempted_at >= job.claimed_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'push delivery attempt does not own the active claim');
    END
  `);
  await knex.raw(`
    CREATE TRIGGER push_delivery_attempts_immutable_update
    BEFORE UPDATE ON push_delivery_attempts
    BEGIN
      SELECT RAISE(ABORT, 'push delivery attempts are immutable');
    END
  `);
  await knex.raw(`
    CREATE TRIGGER push_delivery_attempts_immutable_delete
    BEFORE DELETE ON push_delivery_attempts
    BEGIN
      SELECT RAISE(ABORT, 'push delivery attempts are immutable');
    END
  `);

  // Every state change is forward-only. Retrying moves the job schedule while
  // the inserted attempt remains immutable audit history.
  await knex.raw(`
    CREATE TRIGGER push_delivery_jobs_valid_transition
    BEFORE UPDATE ON push_delivery_jobs
    WHEN NOT (
      (
        NEW.status = OLD.status
        AND NEW.attempt_count = OLD.attempt_count
        AND NEW.next_retry_at IS OLD.next_retry_at
        AND NEW.claim_token IS OLD.claim_token
        AND NEW.claimed_at IS OLD.claimed_at
        AND NEW.lease_expires_at IS OLD.lease_expires_at
      )
      OR (
        OLD.status IN ('pending', 'retryable')
        AND NEW.status = 'processing'
        AND NEW.attempt_count = OLD.attempt_count
        AND NEW.claimed_at <= ${ISO_NOW_SQL}
        AND NEW.lease_expires_at > ${ISO_NOW_SQL}
        AND (
          (OLD.status = 'pending' AND OLD.created_at <= ${ISO_NOW_SQL}
            AND NEW.claimed_at >= OLD.created_at)
          OR (OLD.status = 'retryable' AND OLD.next_retry_at <= ${ISO_NOW_SQL}
            AND NEW.claimed_at >= OLD.next_retry_at)
        )
        AND NOT EXISTS (
          SELECT 1
          FROM push_delivery_attempts AS attempt
          WHERE attempt.job_id = OLD.job_id
            AND attempt.attempt_number = OLD.attempt_count + 1
        )
      )
      OR (
        OLD.status = 'processing'
        AND NEW.status = 'processing'
        AND NEW.attempt_count = OLD.attempt_count
        AND NEW.claim_token IS NOT OLD.claim_token
        AND OLD.lease_expires_at <= ${ISO_NOW_SQL}
        AND NEW.claimed_at >= OLD.lease_expires_at
        AND NEW.claimed_at <= ${ISO_NOW_SQL}
        AND NEW.lease_expires_at > ${ISO_NOW_SQL}
        AND NOT EXISTS (
          SELECT 1
          FROM push_delivery_attempts AS attempt
          WHERE attempt.job_id = OLD.job_id
            AND attempt.attempt_number = OLD.attempt_count + 1
        )
      )
      OR (
        OLD.status = 'processing'
        AND NEW.status IN ('delivered', 'retryable', 'failed')
        AND NEW.attempt_count = OLD.attempt_count + 1
        AND EXISTS (
          SELECT 1
          FROM push_delivery_attempts AS attempt
          WHERE attempt.job_id = OLD.job_id
            AND attempt.attempt_number = NEW.attempt_count
            AND attempt.claim_token = OLD.claim_token
            AND attempt.status = NEW.status
            AND (
              NEW.status != 'retryable'
              OR attempt.next_retry_at = NEW.next_retry_at
            )
        )
      )
      OR (
        OLD.status IN ('pending', 'retryable')
        AND NEW.status = 'cancelled'
        AND NEW.attempt_count = OLD.attempt_count
        AND NOT EXISTS (
          SELECT 1
          FROM push_delivery_attempts AS attempt
          WHERE attempt.job_id = OLD.job_id
            AND attempt.attempt_number = OLD.attempt_count + 1
        )
      )
      OR (
        OLD.status = 'processing'
        AND NEW.status = 'cancelled'
        AND NEW.attempt_count = OLD.attempt_count
        AND OLD.lease_expires_at <= ${ISO_NOW_SQL}
        AND NOT EXISTS (
          SELECT 1
          FROM push_delivery_attempts AS attempt
          WHERE attempt.job_id = OLD.job_id
            AND attempt.attempt_number = OLD.attempt_count + 1
        )
      )
      OR (
        OLD.status = 'processing'
        AND NEW.status = 'cancelled'
        AND NEW.attempt_count = OLD.attempt_count + 1
        AND EXISTS (
          SELECT 1
          FROM push_delivery_attempts AS attempt
          WHERE attempt.job_id = OLD.job_id
            AND attempt.attempt_number = NEW.attempt_count
            AND attempt.claim_token = OLD.claim_token
            AND attempt.status = 'retryable'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM push_subscriptions AS subscription
          WHERE subscription.subscription_id = OLD.subscription_id
            AND subscription.user_id = OLD.user_id
            AND subscription.revoked_at IS NULL
            AND (
              subscription.expires_at IS NULL
              OR subscription.expires_at > ${ISO_NOW_SQL}
            )
        )
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid push delivery job transition');
    END
  `);

  // Inserting the immutable outcome and advancing its mutable job are one
  // SQLite statement. A crash therefore cannot leave an audit row detached
  // from retry scheduling or terminal job state.
  await knex.raw(`
    CREATE TRIGGER push_delivery_attempts_apply_outcome
    AFTER INSERT ON push_delivery_attempts
    BEGIN
      UPDATE push_delivery_jobs
      SET status = CASE
            WHEN NEW.status = 'retryable' AND NOT EXISTS (
              SELECT 1
              FROM push_subscriptions AS subscription
              JOIN push_delivery_jobs AS active_job
                ON active_job.subscription_id = subscription.subscription_id
                AND active_job.user_id = subscription.user_id
              WHERE active_job.job_id = NEW.job_id
                AND subscription.revoked_at IS NULL
                AND (
                  subscription.expires_at IS NULL
                  OR subscription.expires_at > ${ISO_NOW_SQL}
                )
            ) THEN 'cancelled'
            ELSE NEW.status
          END,
          attempt_count = NEW.attempt_number,
          next_retry_at = CASE
            WHEN NEW.status = 'retryable' AND NOT EXISTS (
              SELECT 1
              FROM push_subscriptions AS subscription
              JOIN push_delivery_jobs AS active_job
                ON active_job.subscription_id = subscription.subscription_id
                AND active_job.user_id = subscription.user_id
              WHERE active_job.job_id = NEW.job_id
                AND subscription.revoked_at IS NULL
                AND (
                  subscription.expires_at IS NULL
                  OR subscription.expires_at > ${ISO_NOW_SQL}
                )
            ) THEN NULL
            ELSE NEW.next_retry_at
          END,
          claim_token = NULL,
          claimed_at = NULL,
          lease_expires_at = NULL
      WHERE job_id = NEW.job_id
        AND status = 'processing'
        AND claim_token = NEW.claim_token;
    END
  `);

  await knex.raw(`
    CREATE TRIGGER push_delivery_jobs_claim_eligibility
    BEFORE UPDATE ON push_delivery_jobs
    WHEN NEW.status = 'processing'
      AND (OLD.status != 'processing' OR NEW.claim_token IS NOT OLD.claim_token)
      AND NOT EXISTS (
        SELECT 1
        FROM notification_user_states AS recipient
        JOIN push_subscriptions AS subscription
          ON subscription.subscription_id = NEW.subscription_id
          AND subscription.user_id = NEW.user_id
        WHERE recipient.event_id = NEW.event_id
          AND recipient.user_id = NEW.user_id
          AND recipient.push_enabled = 1
          AND subscription.revoked_at IS NULL
          AND (subscription.expires_at IS NULL OR subscription.expires_at > ${ISO_NOW_SQL})
      )
    BEGIN
      SELECT RAISE(ABORT, 'cannot claim delivery for an inactive subscription');
    END
  `);
  await createUpdatedAtTrigger(
    knex,
    'push_delivery_jobs',
    'job_id = NEW.job_id',
    [
      'job_id',
      'deduplication_key',
      'event_id',
      'user_id',
      'subscription_id',
      'attempt_count',
      'status',
      'next_retry_at',
      'claim_token',
      'claimed_at',
      'lease_expires_at',
      'created_at',
    ]
  );

  // This is the only polling surface for dispatchers. It rechecks recipient
  // eligibility, revocation, and expiration at read time. Workers atomically
  // claim one returned job with a conditional UPDATE ... RETURNING statement.
  await knex.raw(`
    CREATE VIEW push_delivery_claimable_jobs AS
    SELECT job.*
    FROM push_delivery_jobs AS job
    JOIN notification_user_states AS recipient
      ON recipient.event_id = job.event_id
      AND recipient.user_id = job.user_id
      AND recipient.push_enabled = 1
    JOIN push_subscriptions AS subscription
      ON subscription.subscription_id = job.subscription_id
      AND subscription.user_id = job.user_id
      AND subscription.revoked_at IS NULL
      AND (subscription.expires_at IS NULL OR subscription.expires_at > ${ISO_NOW_SQL})
    WHERE (job.status = 'pending' AND job.created_at <= ${ISO_NOW_SQL})
      OR (job.status = 'retryable' AND job.next_retry_at <= ${ISO_NOW_SQL})
      OR (job.status = 'processing' AND job.lease_expires_at <= ${ISO_NOW_SQL})
  `);

  // Natural expiration cannot fire a trigger, so cleanup workers poll this
  // view and terminally cancel the returned rows. A live processing lease is
  // deliberately excluded until its owner records the actual request outcome.
  await knex.raw(`
    CREATE VIEW push_delivery_jobs_requiring_cancellation AS
    SELECT job.*
    FROM push_delivery_jobs AS job
    JOIN push_subscriptions AS subscription
      ON subscription.subscription_id = job.subscription_id
      AND subscription.user_id = job.user_id
    WHERE (
      subscription.revoked_at IS NOT NULL
      OR (
        subscription.expires_at IS NOT NULL
        AND subscription.expires_at <= ${ISO_NOW_SQL}
      )
    )
      AND (
        job.status IN ('pending', 'retryable')
        OR (
          job.status = 'processing'
          AND job.lease_expires_at <= ${ISO_NOW_SQL}
        )
      )
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
      `${boundedNonBlankTextCheck('activity_key')}
        AND ${repositoryCheck('repository')}
        AND (branch IS NULL OR ${boundedNonBlankTextCheck('branch')})
        AND (activity_type = 'indexing' OR branch IS NULL)`,
      {},
      'notification_source_activity_required_text_check'
    );
    table.check(
      "status IN ('queued', 'processing', 'completed', 'failed', 'cancelled')",
      {},
      'notification_source_activity_status_check'
    );
    table.check(
      "(status IN ('queued', 'processing') AND completed_at IS NULL) OR (status IN ('completed', 'failed', 'cancelled') AND completed_at IS NOT NULL)",
      {},
      'notification_source_activity_completion_state_check'
    );
    table.check(
      `CASE
        WHEN metadata_json IS NULL THEN 1
        WHEN typeof(metadata_json) = 'text' AND json_valid(metadata_json) THEN COALESCE(
          json_type(metadata_json) = 'object'
          AND ${utf8ByteLengthCheck('metadata_json', PAYLOAD_LIMITS.metadataBytes)},
          0
        )
        ELSE 0
      END`,
      {},
      'notification_source_activity_metadata_json_check'
    );
    table.check(
      'completed_at IS NULL OR completed_at >= last_activity_at',
      {},
      'notification_source_activity_completed_at_check'
    );
    table.check(
      'updated_at >= created_at',
      {},
      'notification_source_activity_temporal_order_check'
    );
    addTimestampCheck(
      table,
      'last_activity_at',
      'notification_source_activity_last_activity_at_check'
    );
    addTimestampCheck(
      table,
      'completed_at',
      'notification_source_activity_completed_at_timestamp_check',
      true
    );
    addTimestampCheck(
      table,
      'created_at',
      'notification_source_activity_created_at_check'
    );
    addTimestampCheck(
      table,
      'updated_at',
      'notification_source_activity_updated_at_check'
    );
  });

  const sourceManagedTimestamp = `CASE
    WHEN ${ISO_NOW_SQL} > OLD.updated_at THEN ${ISO_NOW_SQL}
    ELSE strftime('%Y-%m-%dT%H:%M:%fZ', OLD.updated_at, '+0.001 seconds')
  END`;
  await knex.raw(`
    CREATE TRIGGER notification_source_activity_insert_guard
    BEFORE INSERT ON notification_source_activity
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
          SELECT 1 FROM notification_source_activity
          WHERE activity_type = NEW.activity_type
            AND activity_key = NEW.activity_key
        ) AND (
          NEW.updated_at > ${ISO_NOW_SQL}
          OR NEW.last_activity_at < NEW.created_at
          OR NEW.last_activity_at > NEW.updated_at
          OR (NEW.completed_at IS NOT NULL AND NEW.completed_at > NEW.updated_at)
        )
        THEN RAISE(ABORT, 'invalid notification source activity timestamps')
      END;
      SELECT CASE WHEN NOT EXISTS (
          SELECT 1 FROM notification_source_activity
          WHERE activity_type = NEW.activity_type
            AND activity_key = NEW.activity_key
        ) AND NEW.metadata_json IS NOT NULL
          AND json_valid(NEW.metadata_json)
          AND ${jsonHasDuplicateKeys('NEW.metadata_json')}
        THEN RAISE(ABORT, 'notification source metadata must not contain duplicate keys')
      END;
      SELECT CASE WHEN NOT EXISTS (
          SELECT 1 FROM notification_source_activity
          WHERE activity_type = NEW.activity_type
            AND activity_key = NEW.activity_key
        ) AND NEW.metadata_json IS NOT NULL
          AND json_valid(NEW.metadata_json)
          AND (
            (SELECT count(*) FROM json_tree(NEW.metadata_json)) > ${PAYLOAD_LIMITS.metadataNodes}
            OR ${jsonDepthExceeds('NEW.metadata_json', PAYLOAD_LIMITS.metadataDepth)}
          )
        THEN RAISE(ABORT, 'notification source metadata exceeds structural limits')
      END;
      SELECT CASE WHEN NOT EXISTS (
          SELECT 1 FROM notification_source_activity
          WHERE activity_type = NEW.activity_type
            AND activity_key = NEW.activity_key
        ) AND NEW.metadata_json IS NOT NULL
          AND json_valid(NEW.metadata_json)
          AND EXISTS (
            SELECT 1
            FROM json_tree(NEW.metadata_json)
            WHERE type IN ('integer', 'real')
              AND NOT (abs(atom) <= 1.7976931348623157e308)
          )
        THEN RAISE(ABORT, 'notification source metadata numbers must be finite')
      END;
    END
  `);

  // Staleness is evaluated first in one guard, before identity, timestamp, or
  // metadata validation. A conflict-upsert of an older heartbeat is therefore
  // a deterministic no-op independent of SQLite's trigger creation order.
  await knex.raw(`
    CREATE TRIGGER notification_source_activity_update_guard
    BEFORE UPDATE ON notification_source_activity
    BEGIN
      SELECT CASE WHEN NEW.last_activity_at < OLD.last_activity_at
          OR (
            OLD.completed_at IS NOT NULL
            AND (
              NEW.completed_at IS NOT OLD.completed_at
              OR NEW.status IS NOT OLD.status
            )
          )
        THEN RAISE(IGNORE)
      END;
      SELECT CASE WHEN NEW.activity_type IS NOT OLD.activity_type
          OR NEW.activity_key IS NOT OLD.activity_key
          OR NEW.created_at IS NOT OLD.created_at
        THEN RAISE(ABORT, 'notification source activity identity is immutable')
      END;
      SELECT CASE WHEN OLD.status = 'processing' AND NEW.status = 'queued'
        THEN RAISE(ABORT, 'notification source activity status cannot regress')
      END;
      SELECT CASE WHEN NEW.updated_at IS NOT OLD.updated_at
          AND NEW.updated_at IS NOT (${sourceManagedTimestamp})
        THEN RAISE(ABORT, 'notification_source_activity.updated_at is database managed')
      END;
      SELECT CASE WHEN NEW.last_activity_at < NEW.created_at
          OR NEW.last_activity_at > (${sourceManagedTimestamp})
          OR (
            NEW.completed_at IS NOT NULL
            AND NEW.completed_at > (${sourceManagedTimestamp})
          )
        THEN RAISE(ABORT, 'invalid notification source activity timestamps')
      END;
      SELECT CASE WHEN NEW.metadata_json IS NOT NULL
          AND json_valid(NEW.metadata_json)
          AND ${jsonHasDuplicateKeys('NEW.metadata_json')}
        THEN RAISE(ABORT, 'notification source metadata must not contain duplicate keys')
      END;
      SELECT CASE WHEN NEW.metadata_json IS NOT NULL
          AND json_valid(NEW.metadata_json)
          AND (
            (SELECT count(*) FROM json_tree(NEW.metadata_json)) > ${PAYLOAD_LIMITS.metadataNodes}
            OR ${jsonDepthExceeds('NEW.metadata_json', PAYLOAD_LIMITS.metadataDepth)}
          )
        THEN RAISE(ABORT, 'notification source metadata exceeds structural limits')
      END;
      SELECT CASE WHEN NEW.metadata_json IS NOT NULL
          AND json_valid(NEW.metadata_json)
          AND EXISTS (
            SELECT 1
            FROM json_tree(NEW.metadata_json)
            WHERE type IN ('integer', 'real')
              AND NOT (abs(atom) <= 1.7976931348623157e308)
          )
        THEN RAISE(ABORT, 'notification source metadata numbers must be finite')
      END;
    END
  `);
  await knex.raw(`
    CREATE TRIGGER notification_source_activity_touch_updated_at
    AFTER UPDATE OF activity_type, activity_key, repository, branch, status,
      last_activity_at, completed_at, metadata_json, created_at
    ON notification_source_activity
    WHEN NEW.updated_at IS OLD.updated_at
    BEGIN
      UPDATE notification_source_activity
      SET updated_at = ${sourceManagedTimestamp}
      WHERE activity_type = NEW.activity_type
        AND activity_key = NEW.activity_key;
    END
  `);

  await knex.raw(`
    CREATE INDEX notification_source_activity_stalled_idx
    ON notification_source_activity (activity_type, last_activity_at, activity_key)
    WHERE completed_at IS NULL
  `);
}

export async function down(knex) {
  await knex.raw('DROP VIEW IF EXISTS push_delivery_jobs_requiring_cancellation');
  await knex.raw('DROP VIEW IF EXISTS push_delivery_claimable_jobs');

  await knex.schema.dropTableIfExists('notification_source_activity');
  await knex.schema.dropTableIfExists('push_delivery_attempts');
  await knex.schema.dropTableIfExists('push_delivery_jobs');
  await knex.schema.dropTableIfExists('push_subscriptions');
  await knex.schema.dropTableIfExists('notification_preferences');
  await knex.schema.dropTableIfExists('notification_user_states');
  await knex.schema.dropTableIfExists('notification_events');
}
