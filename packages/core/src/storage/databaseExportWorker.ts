import { publicExtensionProfile } from '@propr/shared';
/** Shared export policy for process-global and agent environment configuration.
 * Match secret families rather than a provider allowlist so legacy/new providers
 * are covered. Keep path/public-key exceptions here alongside the policy.
 */
export function isExportSecretName(name: string): boolean {
  const key = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
  // HOST_GH_PRIVATE_KEY is a host PEM path despite its name (.env.example).
  if (key === 'HOST_GH_PRIVATE_KEY' || /(?:^|[_-])(?:PATH|FILE|DIR|DIRECTORY)$/.test(key)) return false;
  if (/(?:^|[_-])PUBLIC[_-]?KEY(?:$|[_-])/.test(key)) return false;
  const credential = /(?:^|[_-])(?:SECRETS?|PASSWORDS?|CREDENTIALS?|PRIVATE[_-]?KEY|API[_-]?KEY|ACCESS[_-]?KEY|ENCRYPTION[_-]?KEY)(?:$|[_-])/.test(key);
  const token = /(?:^|[_-])TOKENS?(?:$|[_-])/.test(key);
  const tuning = /(?:^|[_-])(?:MAX|LIMITS?|COUNTS?|BUDGETS?)(?:$|[_-])/.test(key);
  return credential || (token && !tuning);
}

/** Exclude only values shorter than eight trimmed characters and boolean literals
 * to avoid overly broad database-wide substring bans. Numeric credentials at or
 * above that length remain forbidden; tuning settings are excluded by name.
 * Keep the original value for matching; only classification uses trimmed text.
 */
export function isExportSecretValue(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  return text.length >= 8 && !/^(?:true|false)$/i.test(text);
}

/** Runs in a disposable worker: SQLite integrity/VACUUM cannot block API requests. */
export const databaseExportWorker = String.raw`
const publicExtensionProfile = ${publicExtensionProfile.toString()};
const isExportSecretName = ${isExportSecretName.toString()};
const isExportSecretValue = ${isExportSecretValue.toString()};
const { workerData: d, parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const SQLite = require(d.sqliteModule);
(async () => {
  let source, copy;
  try {
    const checkPaths = () => {
      for (const item of d.ancestry) {
        const stat = fs.lstatSync(item.path);
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== item.dev || stat.ino !== item.ino) throw Error('ancestor');
      }
      const stat = fs.lstatSync(d.source);
      if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== d.identity.dev || stat.ino !== d.identity.ino) throw Error('source');
      for (const suffix of ['-wal', '-shm', '-journal']) {
        try {
          const stat = fs.lstatSync(d.source + suffix);
          if (!stat.isFile() || stat.nlink !== 1) throw Error('sidecar');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    };
    checkPaths();
    source = new SQLite(d.source, { readonly: true, fileMustExist: true, timeout: 1000 });
    const pageSize = source.pragma('page_size', { simple: true });
    if (source.pragma('page_count', { simple: true }) * pageSize > d.maxBytes) throw Error('limit');
    await source.backup(d.target, { progress: p => {
      checkPaths();
      if (p.totalPages * pageSize > d.maxBytes) throw Error('limit');
      return 128;
    }});
    checkPaths();
    source.close(); source = undefined;
    fs.chmodSync(d.target, 0o600);
    copy = new SQLite(d.target);
    copy.pragma('journal_mode = DELETE');
    copy.pragma('secure_delete = ON');
    // Infrastructure configuration is not a recoverable customer configuration.
    // Keep customer records and encrypted fields; never decrypt or copy provider homes.
    if (copy.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='system_configs'").get()) {
      const update = copy.prepare('UPDATE system_configs SET value=? WHERE key=?');
      const remove = copy.prepare('DELETE FROM system_configs WHERE key=?');
      for (const row of copy.prepare('SELECT key,value FROM system_configs').all()) {
        if (/^(fleet|operator|routing|tunnel|connect)[_.-]|secret|password|private_key|access_token|api_key/i.test(row.key)) { remove.run(row.key); continue; }
        if (row.key === 'agents') {
          const agents = JSON.parse(row.value);
          if (!Array.isArray(agents)) throw Error('scope');
          for (const agent of agents) {
            for (const [key, value] of Object.entries(agent.envVars || {})) {
              if (isExportSecretName(key) && isExportSecretValue(value)) d.forbiddenSecrets.push(value);
            }
            delete agent.envVars; delete agent.configPath;
          }
          update.run(JSON.stringify(agents), row.key);
        }
      }
    }
    // Export public revision identity and secret presence only; never secret custody or launch authority.
    if (copy.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='extension_profile_revisions'").get()) {
      copy.exec("UPDATE extension_profile_revisions SET secrets_encrypted = ''");
      const update = copy.prepare('UPDATE extension_profile_revisions SET snapshot = ? WHERE rowid = ?');
      for (const row of copy.prepare('SELECT rowid, snapshot FROM extension_profile_revisions').all()) update.run(JSON.stringify(publicExtensionProfile(JSON.parse(row.snapshot))), row.rowid);
    }
    if (copy.prepare("SELECT 1 FROM pragma_table_info('task_submissions') WHERE name='extension_authorization'").get()) copy.exec("UPDATE task_submissions SET extension_authorization = NULL");
    if (copy.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='extension_run_grants'").get()) copy.exec('DELETE FROM extension_run_grants');
    // Rebuild pages so removed fields/free pages cannot leak in the downloadable file.
    copy.exec('VACUUM');
    const integrity = copy.pragma('integrity_check');
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw Error('integrity');
    if (copy.pragma('foreign_key_check').length) throw Error('foreign keys');
    const schemaVersion = copy.pragma('user_version', { simple: true });
    const hasMigrations = copy.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='knex_migrations'").get();
    const migration = hasMigrations ? copy.prepare('SELECT name FROM knex_migrations ORDER BY id DESC LIMIT 1').get()?.name ?? null : null;
    // Scan logical values too: an overflow-page boundary must not hide a secret.
    const secretStrings = [...new Set(d.forbiddenSecrets.flatMap(value => [value, JSON.stringify(value).slice(1, -1)]))];
    for (const table of copy.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
      const identifier = '"' + table.name.replace(/"/g, '""') + '"';
      for (const row of copy.prepare('SELECT * FROM ' + identifier).iterate()) {
        for (const value of Object.values(row)) {
          if (typeof value === 'string' && secretStrings.some(secret => value.includes(secret))) throw Error('scope');
          if (Buffer.isBuffer(value) && secretStrings.some(secret => value.includes(Buffer.from(secret)))) throw Error('scope');
        }
      }
    }
    copy.close(); copy = undefined;
    const sizeBytes = fs.statSync(d.target).size;
    if (sizeBytes > d.maxBytes) throw Error('limit');
    const hash = crypto.createHash('sha256');
    // Historical logs may predate provider-log hygiene. Never release a copy
    // containing a configured infrastructure secret, even outside its declared field.
    const forbidden = d.forbiddenSecrets.flatMap(value => [Buffer.from(value), Buffer.from(value, 'utf16le'), Buffer.from(value, 'utf16le').swap16()]);
    if (forbidden.some(value => value.length > 65536)) throw Error('scope');
    const overlap = Math.max(1, ...forbidden.map(value => value.length)) - 1;
    let previous = Buffer.alloc(0);
    for await (const chunk of fs.createReadStream(d.target)) {
      const window = Buffer.concat([previous, chunk]);
      if (forbidden.some(value => window.includes(value))) throw Error('scope');
      previous = overlap ? window.subarray(-overlap) : Buffer.alloc(0);
      hash.update(chunk);
    }
    parentPort.postMessage({ sizeBytes, sha256: hash.digest('hex'), schemaVersion, migration });
  } catch { parentPort.postMessage({ failed: true }); }
  finally { if (source?.open) source.close(); if (copy?.open) copy.close(); }
})();
`;
