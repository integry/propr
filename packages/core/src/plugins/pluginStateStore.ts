import type { Knex } from 'knex';
import { PLUGIN_STATE_LIMITS, PluginSdkError, type PluginJsonValue, type PluginPermission, type PluginStateStore } from '@propr/shared';

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

function requireLive(guard: PluginStateWriteGuard): void {
  if (guard.signal?.aborted) throw new PluginSdkError('unavailable', 'This handler run has ended');
}

/** What an installation currently authorizes, as an administrator last set it. */
export interface PluginInstallationAuthority {
  enabled: boolean;
  grantedPermissions: PluginPermission[];
  /** The repository limit (`owner/repo`); null for all repositories. */
  repositories: string[] | null;
}
type AuthorityRow = { installed_at: number | string; enabled: number | boolean; granted_permissions: string | null; repositories: string | null };
const json = <T>(value: string | null, fallback: T): T => {
  if (value === null || value === undefined) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
};

/**
 * Inside a state operation's transaction: require the installation to still
 * exist (the same one, not a reinstall) and keep it until commit. Uninstall
 * deletes the installation row before the state rows, so an operation either
 * commits first (a write is then deleted with the rest), or finds the
 * installation gone. The instance database is SQLite, which runs write
 * transactions one at a time, so no row lock is taken. Returns
 * what the installation authorizes right now (enabled, grants, repository
 * limit), read in the same transaction, for a caller about to act on it.
 */
export async function requireInstallation(trx: Knex.Transaction, pluginId: string, guard: PluginStateWriteGuard): Promise<PluginInstallationAuthority> {
  const row = await trx('plugin_installations').where({ plugin_id: pluginId }).first('installed_at', 'enabled', 'granted_permissions', 'repositories') as AuthorityRow | undefined;
  if (!row || Number(row.installed_at) !== guard.installedAt) throw new PluginSdkError('unavailable', 'The plugin is no longer installed');
  requireLive(guard);
  const permissions = json<unknown>(row.granted_permissions, []);
  const repositories = json<unknown>(row.repositories, null);
  return {
    enabled: Boolean(row.enabled),
    grantedPermissions: Array.isArray(permissions) ? permissions.filter((p): p is PluginPermission => typeof p === 'string') : [],
    repositories: Array.isArray(repositories) ? repositories.filter((r): r is string => typeof r === 'string') : null,
  };
}

/**
 * `ctx.state`: JSON values per installation in `plugin_state`, with a key
 * count, a per-value size and a total size limit. A write that would exceed
 * a limit throws `state_limit` and changes nothing. With a `guard`, every
 * operation (read, write, delete, list) runs in a transaction that requires
 * its installation to still exist, and is refused (a change rolled back)
 * when the handler run ends before it commits. `update` reads and writes in
 * one transaction (SQLite runs write transactions one at a time), so updates
 * never interleave across processes.
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
  const checkSize = (text: string) => {
    const bytes = Buffer.byteLength(text);
    if (bytes > PLUGIN_STATE_LIMITS.valueBytes) throw new PluginSdkError('state_limit', `A state value is at most ${PLUGIN_STATE_LIMITS.valueBytes} bytes; this one is ${bytes}`);
    return bytes;
  };
  const write = async (trx: Knex.Transaction, stateKey: string, text: string, bytes: number) => {
    // The other keys' count and size: a rewrite of a key replaces its own bytes.
    const totals = await rows(trx).whereNot({ state_key: stateKey })
      .first(trx.raw('COUNT(*) AS count'), trx.raw('COALESCE(SUM(bytes), 0) AS total')) as { count: number | string; total: number | string } | undefined;
    if (guard) requireLive(guard);
    const count = Number(totals?.count ?? 0); const total = Number(totals?.total ?? 0);
    if (count + 1 > PLUGIN_STATE_LIMITS.keys) throw new PluginSdkError('state_limit', `The plugin state holds at most ${PLUGIN_STATE_LIMITS.keys} keys`);
    if (total + bytes > PLUGIN_STATE_LIMITS.totalBytes) throw new PluginSdkError('state_limit', `The plugin state holds at most ${PLUGIN_STATE_LIMITS.totalBytes} bytes`);
    await trx(PLUGIN_STATE_TABLE).insert({ plugin_id: pluginId, state_key: stateKey, value: text, bytes, updated_at: now() })
      .onConflict(['plugin_id', 'state_key']).merge();
  };
  return {
    async get<T extends PluginJsonValue = PluginJsonValue>(key: string): Promise<T | undefined> {
      const stateKey = checkKey(key);
      const row = await fenced(trx => rows(trx).where({ state_key: stateKey }).first('value'));
      return row ? JSON.parse(row.value as string) as T : undefined;
    },
    async set(key: string, value: PluginJsonValue): Promise<void> {
      const stateKey = checkKey(key);
      const text = serialize(value);
      const bytes = checkSize(text);
      await fenced(trx => write(trx, stateKey, text, bytes));
    },
    async update(key: string, change: (current: PluginJsonValue | undefined) => PluginJsonValue | undefined): Promise<PluginJsonValue | undefined> {
      const stateKey = checkKey(key);
      if (typeof change !== 'function') throw new PluginSdkError('invalid_input', 'update needs a function computing the new value');
      return fenced(async trx => {
        const row = await rows(trx).where({ state_key: stateKey }).first('value');
        const current = row ? JSON.parse(row.value as string) as PluginJsonValue : undefined;
        const next = change(current);
        if (next === undefined) return current;
        const text = serialize(next);
        await write(trx, stateKey, text, checkSize(text));
        return JSON.parse(text) as PluginJsonValue;
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
