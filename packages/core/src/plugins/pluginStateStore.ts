import type { Knex } from 'knex';
import { PLUGIN_STATE_LIMITS, PluginSdkError, type PluginJsonValue, type PluginStateStore } from '@propr/shared';

export const PLUGIN_STATE_TABLE = 'plugin_state';
const KEY_PATTERN = /^[\x21-\x7e]+$/;

function checkKey(key: unknown): string {
  if (typeof key !== 'string' || !key.length || key.length > PLUGIN_STATE_LIMITS.keyLength || !KEY_PATTERN.test(key)) {
    throw new PluginSdkError('invalid_input', `State keys are 1 to ${PLUGIN_STATE_LIMITS.keyLength} printable characters without spaces`);
  }
  return key;
}

/** Serialize a value, refusing anything that is not plain JSON (a function, a cycle, NaN, a class instance). */
function serialize(value: unknown): string {
  const plain = (item: unknown, depth: number): boolean => {
    if (depth > 32) return false;
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (Array.isArray(item)) return item.every(entry => plain(entry, depth + 1));
    if (typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype) return Object.values(item as object).every(entry => plain(entry, depth + 1));
    return false;
  };
  if (!plain(value, 0)) throw new PluginSdkError('invalid_input', 'State values must be plain JSON: objects, arrays, text, finite numbers, booleans or null');
  return JSON.stringify(value);
}

export interface PluginStateWriteGuard {
  /** The installation the state belongs to (its `installed_at`); every operation is refused once it is uninstalled or replaced. */
  installedAt: number;
  /** The handler run's signal: an operation that has not committed when the run ends is refused and rolled back. */
  signal?: AbortSignal;
}

const isSqlite = (database: Knex) => ['better-sqlite3', 'sqlite3'].includes(String(database.client.config.client));

function requireLive(guard: PluginStateWriteGuard): void {
  if (guard.signal?.aborted) throw new PluginSdkError('unavailable', 'This handler run has ended');
}

/**
 * Inside a state operation's transaction: require the installation to still
 * exist (the same one, not a reinstall) and keep it until commit. Uninstall
 * deletes the installation row before the state rows, so an operation either
 * commits first (a write is then deleted with the rest), or finds the
 * installation gone. SQLite runs write transactions one at a time.
 */
export async function requireInstallation(trx: Knex.Transaction, pluginId: string, guard: PluginStateWriteGuard): Promise<void> {
  const query = trx('plugin_installations').where({ plugin_id: pluginId });
  const row = await (isSqlite(trx) ? query : query.forShare()).first('installed_at') as { installed_at: number | string } | undefined;
  if (!row || Number(row.installed_at) !== guard.installedAt) throw new PluginSdkError('unavailable', 'The plugin is no longer installed');
  requireLive(guard);
}

/**
 * `ctx.state`: JSON values per installation in `plugin_state`, with a key
 * count, a per-value size and a total size limit. A write that would exceed
 * a limit throws `state_limit` and changes nothing. With a `guard`, every
 * operation (read, write, delete, list) runs in a transaction that requires
 * its installation to still exist, and is refused (a change rolled back)
 * when the handler run ends before it commits.
 */
export function pluginStateStore(database: Knex, pluginId: string, now: () => number = Date.now, guard?: PluginStateWriteGuard): PluginStateStore {
  const fenced = <R>(run: (trx: Knex.Transaction) => Promise<R>): Promise<R> => database.transaction(async trx => {
    if (guard) await requireInstallation(trx, pluginId, guard);
    const result = await run(trx);
    // Cancellation observed during the operation: throwing rolls a change back.
    if (guard) requireLive(guard);
    return result;
  });
  const rows = (trx: Knex.Transaction) => trx(PLUGIN_STATE_TABLE).where({ plugin_id: pluginId });
  return {
    async get<T extends PluginJsonValue = PluginJsonValue>(key: string): Promise<T | undefined> {
      const stateKey = checkKey(key);
      const row = await fenced(trx => rows(trx).where({ state_key: stateKey }).first('value'));
      return row ? JSON.parse(row.value as string) as T : undefined;
    },
    async set(key: string, value: PluginJsonValue): Promise<void> {
      const stateKey = checkKey(key);
      const text = serialize(value);
      const bytes = Buffer.byteLength(text);
      if (bytes > PLUGIN_STATE_LIMITS.valueBytes) throw new PluginSdkError('state_limit', `A state value is at most ${PLUGIN_STATE_LIMITS.valueBytes} bytes; this one is ${bytes}`);
      await fenced(async trx => {
        // The other keys' count and size: a rewrite of a key replaces its own bytes.
        const totals = await rows(trx).whereNot({ state_key: stateKey })
          .first(trx.raw('COUNT(*) AS count'), trx.raw('COALESCE(SUM(bytes), 0) AS total')) as { count: number | string; total: number | string } | undefined;
        if (guard) requireLive(guard);
        const count = Number(totals?.count ?? 0); const total = Number(totals?.total ?? 0);
        if (count + 1 > PLUGIN_STATE_LIMITS.keys) throw new PluginSdkError('state_limit', `The plugin state holds at most ${PLUGIN_STATE_LIMITS.keys} keys`);
        if (total + bytes > PLUGIN_STATE_LIMITS.totalBytes) throw new PluginSdkError('state_limit', `The plugin state holds at most ${PLUGIN_STATE_LIMITS.totalBytes} bytes`);
        await trx(PLUGIN_STATE_TABLE).insert({ plugin_id: pluginId, state_key: stateKey, value: text, bytes, updated_at: now() })
          .onConflict(['plugin_id', 'state_key']).merge();
      });
    },
    async delete(key: string): Promise<boolean> {
      const stateKey = checkKey(key);
      return (await fenced(trx => rows(trx).where({ state_key: stateKey }).delete())) > 0;
    },
    async keys(prefix = ''): Promise<string[]> {
      if (typeof prefix !== 'string') throw new PluginSdkError('invalid_input', 'The key prefix must be text');
      const list = await fenced(trx => rows(trx).orderBy('state_key').pluck('state_key')) as string[];
      return list.filter(key => key.startsWith(prefix));
    },
  };
}

/** Delete every state value of a plugin: on uninstall. */
export async function deletePluginState(database: Knex, pluginId: string): Promise<number> {
  return database(PLUGIN_STATE_TABLE).where({ plugin_id: pluginId }).delete();
}
