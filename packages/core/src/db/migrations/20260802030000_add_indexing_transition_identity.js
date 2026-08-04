import { createHash } from 'node:crypto';

const CASE_INSENSITIVE_UNIQUE_INDEX = 'repositories_full_name_ci_branch_unique';
const EXACT_REPOSITORY_REFERENCES = [
  ['task_drafts', 'repository'],
  ['plan_issues', 'repository'],
  ['tasks', 'repository'],
  ['llm_logs', 'repository'],
  ['llm_logs', 'work_repository'],
  ['repo_chat_messages', 'repository'],
  ['repo_todo_categories', 'repository'],
  ['repo_todos', 'repository'],
  ['notification_source_activity', 'repository'],
];
const SUMMARY_PATH_REFERENCES = ['file_summaries', 'directory_summaries'];
const INVENTORIED_EXACT_REFERENCES = new Set(
  EXACT_REPOSITORY_REFERENCES.map(([table, column]) => `${table}.${column}`)
);

/**
 * Give repository indexing state its own transition identity. repositories.updated_at
 * is shared by unrelated repository metadata and cannot safely deduplicate status events.
 *
 * IRREVERSIBLE DATA CHANGE: repository names are lowercased and case-colliding
 * repository/dependent rows are merged. `down()` removes only the added schema;
 * it cannot reconstruct aliases or rows discarded by that merge.
 */
export async function up(knex) {
  if (!await knex.schema.hasTable('repositories')) return;
  await assertExactRepositoryReferenceInventory(knex);

  const hasTransitionAt = await knex.schema.hasColumn('repositories', 'indexing_transition_at');
  const hasRunId = await knex.schema.hasColumn('repositories', 'indexing_run_id');
  await knex.schema.alterTable('repositories', (table) => {
    if (!hasTransitionAt) table.text('indexing_transition_at').nullable();
    if (!hasRunId) table.text('indexing_run_id').nullable();
  });

  await knex.raw(`
    UPDATE repositories
    SET indexing_transition_at = updated_at
    WHERE indexing_transition_at IS NULL
  `);
  await canonicalizeRepositories(knex);
  await backfillLegacyActiveRunIds(knex);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${CASE_INSENSITIVE_UNIQUE_INDEX}
    ON repositories (lower(full_name), branch)
  `);
  await knex.schema.alterTable('repositories', (table) => {
    table.index(['indexing_status', 'indexing_transition_at'], 'repositories_indexing_transition_idx');
  });
}

export async function down(knex) {
  // Canonicalized names and merged duplicate data deliberately remain. There is
  // no lossless mapping back to the aliases/rows that existed before `up()`.
  if (!await knex.schema.hasTable('repositories')) return;
  await knex.raw(`DROP INDEX IF EXISTS ${CASE_INSENSITIVE_UNIQUE_INDEX}`);
  await knex.schema.alterTable('repositories', (table) => {
    table.dropIndex(['indexing_status', 'indexing_transition_at'], 'repositories_indexing_transition_idx');
  });
  const columns = [];
  if (await knex.schema.hasColumn('repositories', 'indexing_transition_at')) {
    columns.push('indexing_transition_at');
  }
  if (await knex.schema.hasColumn('repositories', 'indexing_run_id')) {
    columns.push('indexing_run_id');
  }
  if (columns.length > 0) {
    await knex.schema.alterTable('repositories', (table) => table.dropColumns(...columns));
  }
}

/** Fail the upgrade instead of silently leaving an unknown exact reference inconsistent. */
async function assertExactRepositoryReferenceInventory(knex) {
  const tables = await knex('sqlite_master')
    .select('name')
    .where({ type: 'table' })
    .whereNot('name', 'like', 'sqlite_%');
  const unhandled = [];
  for (const { name } of tables) {
    const columns = await knex(name).columnInfo();
    for (const column of ['repository', 'work_repository']) {
      if (column in columns && !INVENTORIED_EXACT_REFERENCES.has(`${name}.${column}`)) {
        unhandled.push(`${name}.${column}`);
      }
    }
  }
  if (unhandled.length > 0) {
    throw new Error(
      `Indexing identity migration has unhandled repository references: ${unhandled.sort().join(', ')}`
    );
  }
}

function rowTransitionTime(row) {
  const value = row.indexing_transition_at ?? row.updated_at;
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

async function canonicalizeRepositories(knex) {
  const columnInfo = await knex('repositories').columnInfo();
  const metadataColumns = [
    'last_indexed_at',
    'last_indexed_hash',
    'last_indexed_commit_message',
    'icon_path',
    'created_at',
  ].filter((column) => column in columnInfo);
  const rows = await knex('repositories').select('*');
  const groups = new Map();
  for (const row of rows) {
    const canonicalName = row.full_name.trim().toLowerCase();
    const key = JSON.stringify([canonicalName, row.branch]);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  for (const [key, group] of groups) {
    const [canonicalName] = JSON.parse(key);
    group.sort((left, right) => rowTransitionTime(right) - rowTransitionTime(left)
      || left.full_name.localeCompare(right.full_name));
    const [winner] = group;
    const mergedMetadata = mergeRepositoryMetadata(winner, group, metadataColumns);
    const aliases = [...new Set(group.map((row) => row.full_name))];
    const canonicalRow = group.find((row) => row.full_name === canonicalName);
    const canonicalData = { ...winner, ...mergedMetadata, full_name: canonicalName };
    if (canonicalRow) {
      const update = { ...canonicalData };
      delete update.full_name;
      delete update.branch;
      await knex('repositories').where({
        full_name: canonicalName,
        branch: winner.branch,
      }).update(update);
    } else {
      await knex('repositories').insert(canonicalData);
    }
    await canonicalizeDependentRepositoryData(
      knex, aliases, canonicalName, winner.branch
    );
    await knex('repositories')
      .where({ branch: winner.branch })
      .whereIn('full_name', aliases.filter((name) => name !== canonicalName))
      .delete();
  }
}

async function canonicalizeDependentRepositoryData(knex, aliases, canonicalName, branch) {
  for (const [table, column] of EXACT_REPOSITORY_REFERENCES) {
    if (!await knex.schema.hasTable(table)
        || !await knex.schema.hasColumn(table, column)) continue;
    await knex(table).whereRaw('lower(trim(??)) = ?', [column, canonicalName])
      .whereNot(column, canonicalName)
      .update({ [column]: canonicalName });
  }
  for (const table of SUMMARY_PATH_REFERENCES) {
    if (!await knex.schema.hasTable(table)
        || !await knex.schema.hasColumn(table, 'path')) continue;
    await canonicalizeSummaryPaths(knex, table, aliases, canonicalName);
  }
  if (await knex.schema.hasTable('repository_indexing_transitions')
      && await knex.schema.hasColumn('repository_indexing_transitions', 'full_name')) {
    await knex('repository_indexing_transitions')
      .where({ branch })
      .whereRaw('lower(trim(full_name)) = ?', [canonicalName])
      .whereNot('full_name', canonicalName)
      .update({ full_name: canonicalName });
  }
  if (await knex.schema.hasTable('notification_events')
      && await knex.schema.hasColumn('notification_events', 'target_json')) {
    await knex('notification_events')
      .whereRaw("json_valid(target_json) AND lower(json_extract(target_json, '$.repository')) = ?", [canonicalName])
      .update({
        target_json: knex.raw("json_set(target_json, '$.repository', ?)", [canonicalName])
      });
  }
  await canonicalizeUserRepositoryPreferences(knex, canonicalName);
  await canonicalizeTaskJobData(knex, canonicalName);
}

async function canonicalizeSummaryPaths(knex, table, aliases, canonicalName) {
  const rows = await knex(table).select('*').whereRaw(
    'lower(path) = ? OR substr(lower(path), 1, ?) = ?',
    [canonicalName, canonicalName.length + 1, `${canonicalName}/`]
  );
  for (const row of rows) {
    const alias = aliases.find((candidate) => row.path.toLowerCase() === candidate.toLowerCase()
      || row.path.toLowerCase().startsWith(`${candidate.toLowerCase()}/`));
    if (!alias) continue;
    const canonicalPath = `${canonicalName}${row.path.slice(alias.length)}`;
    if (canonicalPath === row.path) continue;
    const identity = { path: canonicalPath, branch: row.branch };
    const existing = await knex(table).where(identity).first();
    if (!existing) {
      await knex(table).where({ path: row.path, branch: row.branch })
        .update({ path: canonicalPath });
      continue;
    }
    if (summaryUpdatedAt(row) > summaryUpdatedAt(existing)) {
      const merged = { ...row };
      delete merged.path;
      delete merged.branch;
      await knex(table).where(identity).update(merged);
    }
    await knex(table).where({ path: row.path, branch: row.branch }).delete();
  }
}

function summaryUpdatedAt(row) {
  const parsed = typeof row.last_updated_at === 'string'
    ? Date.parse(row.last_updated_at)
    : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

async function canonicalizeUserRepositoryPreferences(knex, canonicalName) {
  if (!await knex.schema.hasTable('system_configs')
      || !await knex.schema.hasColumn('system_configs', 'value')) return;
  const rows = await knex('system_configs').select('key', 'value')
    .where('key', 'like', 'user_repo_prefs_%');
  for (const row of rows) {
    let preferences;
    try {
      preferences = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
    } catch {
      continue;
    }
    if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) continue;
    const entries = Object.entries(preferences);
    const matches = entries.filter(([repository]) =>
      repository.trim().toLowerCase() === canonicalName);
    if (matches.length === 0
        || (matches.length === 1 && matches[0][0] === canonicalName)) continue;
    const merged = {};
    const orderedMatches = [...matches].sort(([left], [right]) =>
      Number(left === canonicalName) - Number(right === canonicalName));
    for (const [, preference] of orderedMatches) {
      if (preference && typeof preference === 'object' && !Array.isArray(preference)) {
        Object.assign(merged, preference);
      }
    }
    const normalized = Object.fromEntries(entries.filter(([repository]) =>
      repository.trim().toLowerCase() !== canonicalName));
    normalized[canonicalName] = merged;
    await knex('system_configs').where({ key: row.key })
      .update({ value: JSON.stringify(normalized) });
  }
}

async function canonicalizeTaskJobData(knex, canonicalName) {
  if (!await knex.schema.hasTable('tasks')
      || !await knex.schema.hasColumn('tasks', 'initial_job_data')) return;
  const [owner, repositoryName] = canonicalName.split('/');
  await knex('tasks')
    .whereRaw("json_valid(initial_job_data) AND lower(trim(json_extract(initial_job_data, '$.repository'))) = ?", [canonicalName])
    .update({
      initial_job_data: knex.raw(
        "json_set(initial_job_data, '$.repository', ?)",
        [canonicalName]
      )
    });
  await knex('tasks')
    .whereRaw(`json_valid(initial_job_data)
      AND lower(trim(json_extract(initial_job_data, '$.repoOwner')) || '/' ||
        trim(json_extract(initial_job_data, '$.repoName'))) = ?`, [canonicalName])
    .update({
      initial_job_data: knex.raw(
        "json_set(initial_job_data, '$.repoOwner', ?, '$.repoName', ?)",
        [owner, repositoryName]
      )
    });
}

function hasMetadata(value) {
  return value !== null && value !== undefined && (typeof value !== 'string' || value.trim() !== '');
}

function metadataTime(row) {
  const parsed = typeof row.last_indexed_at === 'string'
    ? Date.parse(row.last_indexed_at)
    : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function firstMetadata(rows, column) {
  return rows.find((row) => hasMetadata(row[column]))?.[column];
}

function mergeRepositoryMetadata(winner, group, metadataColumns) {
  const merged = {};
  const indexedRows = [...group].sort((left, right) => metadataTime(right) - metadataTime(left)
    || rowTransitionTime(right) - rowTransitionTime(left));
  if (metadataColumns.includes('last_indexed_at')) {
    const lastIndexedAt = firstMetadata(indexedRows, 'last_indexed_at');
    if (lastIndexedAt !== undefined && winner.last_indexed_at !== lastIndexedAt) {
      merged.last_indexed_at = lastIndexedAt;
    }
  }
  for (const column of ['last_indexed_hash', 'last_indexed_commit_message']) {
    if (!metadataColumns.includes(column)) continue;
    const value = firstMetadata(indexedRows, column);
    if (value !== undefined && winner[column] !== value) merged[column] = value;
  }
  if (metadataColumns.includes('icon_path')) {
    const iconPath = firstMetadata([winner, ...group.filter((row) => row !== winner)], 'icon_path');
    if (iconPath !== undefined && winner.icon_path !== iconPath) merged.icon_path = iconPath;
  }
  if (metadataColumns.includes('created_at')) {
    const createdAt = [...group].map((row) => row.created_at).filter(hasMetadata).sort()[0];
    if (createdAt !== undefined && winner.created_at !== createdAt) merged.created_at = createdAt;
  }
  return merged;
}

async function backfillLegacyActiveRunIds(knex) {
  const activeRows = await knex('repositories')
    .whereRaw('lower(indexing_status) = ?', ['indexing'])
    .whereNull('indexing_run_id')
    .select('full_name', 'branch', 'indexing_transition_at');
  for (const row of activeRows) {
    const runId = `legacy-${createHash('sha256')
      .update(`${row.full_name}\0${row.branch}\0${row.indexing_transition_at ?? ''}`)
      .digest('hex')}`;
    await knex('repositories').where({
      full_name: row.full_name,
      branch: row.branch,
    }).whereNull('indexing_run_id').update({ indexing_run_id: runId });
  }
}
