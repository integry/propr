import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import { pluginSharedCommandSiblings, type PluginCommandSettingView, type PluginManifest, type PluginSharedCommandCandidate } from '@propr/shared';
import { PluginError } from './pluginState.js';

/**
 * Instance settings of plugin slash commands, and the explicit write grants of
 * `needsWrite` command runs.
 *
 * - The write switch ("Allow this command to use write access") of a
 *   `needsWrite` command: off until an administrator switches it on.
 * - The owner of a `shared` command name: which plugin the plain name runs
 *   when several enabled plugins offer it for a repository.
 * - A write grant: made when a `needsWrite` command is accepted (the switch is
 *   on and the commenter has write permission) and consumed once, by the run
 *   it was made for. A retry or a later follow-up finds it consumed.
 */

/** How long an accepted command's write grant waits for its run to start. */
export const PLUGIN_COMMAND_WRITE_GRANT_TTL_MS = 24 * 60 * 60 * 1000;

interface SettingRow { plugin_id: string; command: string; allow_write: number | boolean; updated_by: string; updated_at: number | string }
interface OwnerRow { command: string; plugin_id: string; set_by: string; set_at: number | string }

/** What command resolution reads: the commands allowed write access (`<plugin>/<command>`) and the shared command owners. */
export interface PluginCommandAccess { writeAllowed: ReadonlySet<string>; owners: ReadonlyMap<string, string> }
export const commandKey = (pluginId: string, command: string) => `${pluginId}/${command}`;

export async function readPluginCommandAccess(database: Knex): Promise<PluginCommandAccess> {
  const [settings, owners] = await Promise.all([
    database('plugin_command_settings').where({ allow_write: true }).select('plugin_id', 'command') as Promise<Pick<SettingRow, 'plugin_id' | 'command'>[]>,
    database('plugin_shared_command_owners').select('command', 'plugin_id') as Promise<Pick<OwnerRow, 'command' | 'plugin_id'>[]>,
  ]);
  return { writeAllowed: new Set(settings.map(row => commandKey(row.plugin_id, row.command))), owners: new Map(owners.map(row => [row.command, row.plugin_id])) };
}

/** Every installed plugin whose current manifest offers `command` as a shared command. */
function sharedCandidates(command: string, manifests: readonly PluginManifest[], installed: readonly { plugin_id: string; enabled: number | boolean }[]): PluginSharedCommandCandidate[] {
  return installed.flatMap(row => {
    const manifest = manifests.find(m => m.id === row.plugin_id);
    const offered = manifest?.contributes.commands.find(c => c.name === command && c.shared);
    if (!manifest || !offered) return [];
    return [{ pluginId: manifest.id, pluginName: manifest.name, specific: pluginSharedCommandSiblings(manifest.contributes.commands, offered).map(c => c.name), enabled: Boolean(row.enabled) }];
  }).sort((a, b) => (a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0));
}

/** The command settings of one plugin as the Plugins page shows them. */
export async function pluginCommandSettingViews(database: Knex, manifest: PluginManifest, manifests: readonly PluginManifest[]): Promise<PluginCommandSettingView[]> {
  const commands = manifest.contributes.commands;
  if (!commands.length) return [];
  const settings = await database('plugin_command_settings').where({ plugin_id: manifest.id }).select() as SettingRow[];
  const shared = commands.filter(c => c.shared).map(c => c.name);
  const owners = shared.length ? await database('plugin_shared_command_owners').whereIn('command', shared).select() as OwnerRow[] : [];
  const installed = shared.length ? await database('plugin_installations').select('plugin_id', 'enabled') as { plugin_id: string; enabled: number | boolean }[] : [];
  return commands.map(command => {
    const setting = settings.find(row => row.command === command.name);
    const owner = owners.find(row => row.command === command.name);
    return {
      name: command.name, needsWrite: command.needsWrite,
      writeAllowed: command.needsWrite && Boolean(setting?.allow_write),
      ...(setting ? { writeChangedBy: setting.updated_by, writeChangedAt: Number(setting.updated_at) } : {}),
      ...(command.shared ? {
        sharedOwner: {
          owner: owner?.plugin_id ?? null, ...(owner ? { setBy: owner.set_by, setAt: Number(owner.set_at) } : {}),
          candidates: sharedCandidates(command.name, manifests, installed),
        },
      } : {}),
    };
  });
}

/** Switch a `needsWrite` command's write access on or off. Returns the audit detail. */
// eslint-disable-next-line max-params -- the transaction, manifest, command, switch, actor and time are explicit inputs
export async function setPluginCommandWrite(trx: Knex, manifest: PluginManifest, name: unknown, allowed: unknown, actor: string, now: number): Promise<Record<string, unknown>> {
  if (typeof allowed !== 'boolean') throw new PluginError(400, 'allowed must be true or false');
  const command = manifest.contributes.commands.find(c => c.name === name);
  if (!command) throw new PluginError(404, 'Command not found');
  if (!command.needsWrite) throw new PluginError(409, `Command /${command.name} does not use write access`);
  const previous = await trx('plugin_command_settings').where({ plugin_id: manifest.id, command: command.name }).first('allow_write') as Pick<SettingRow, 'allow_write'> | undefined;
  await trx('plugin_command_settings').insert({ plugin_id: manifest.id, command: command.name, allow_write: allowed, updated_by: actor, updated_at: now })
    .onConflict(['plugin_id', 'command']).merge();
  return { command: command.name, allowWrite: allowed, previous: Boolean(previous?.allow_write) };
}

/**
 * Choose (a plugin id) or clear (`null`) the owner of a shared command name
 * that `manifest` offers. The owner must be installed and offer the name as a
 * shared command. Returns the audit detail and the other plugins to record it on.
 */
// eslint-disable-next-line max-params -- the transaction, manifests, command, owner, actor and time are explicit inputs
export async function setPluginSharedCommandOwner(trx: Knex, input: { manifest: PluginManifest; manifests: readonly PluginManifest[] }, name: unknown, owner: unknown, actor: string, now: number): Promise<{ detail: Record<string, unknown>; alsoAudit: string[] }> {
  const command = input.manifest.contributes.commands.find(c => c.name === name);
  if (!command) throw new PluginError(404, 'Command not found');
  if (!command.shared) throw new PluginError(409, `Command /${command.name} is not a shared command`);
  if (owner !== null && typeof owner !== 'string') throw new PluginError(400, 'owner must be a plugin id or null');
  const installed = await trx('plugin_installations').select('plugin_id', 'enabled') as { plugin_id: string; enabled: number | boolean }[];
  const candidates = sharedCandidates(command.name, input.manifests, installed);
  if (owner !== null && !candidates.some(c => c.pluginId === owner)) throw new PluginError(409, `Plugin ${owner.slice(0, 64)} is not installed or does not offer /${command.name}`);
  const previous = await trx('plugin_shared_command_owners').where({ command: command.name }).first('plugin_id') as Pick<OwnerRow, 'plugin_id'> | undefined;
  if (owner === null) await trx('plugin_shared_command_owners').where({ command: command.name }).delete();
  else await trx('plugin_shared_command_owners').insert({ command: command.name, plugin_id: owner, set_by: actor, set_at: now }).onConflict('command').merge();
  const alsoAudit = [...new Set([previous?.plugin_id, owner].filter((id): id is string => typeof id === 'string' && id !== input.manifest.id))];
  return { detail: { command: command.name, owner, previous: previous?.plugin_id ?? null }, alsoAudit };
}

/** Delete a plugin's command settings and the shared command names it owns (uninstall). */
export async function deletePluginCommandSettings(trx: Knex, pluginId: string): Promise<void> {
  await trx('plugin_command_settings').where({ plugin_id: pluginId }).delete();
  await trx('plugin_shared_command_owners').where({ plugin_id: pluginId }).delete();
  await trx('plugin_command_write_grants').where({ plugin_id: pluginId }).whereNull('consumed_at').delete();
}

/** What a write grant is bound to: the command run it was made for. */
export interface PluginCommandWriteGrantScope { pluginId: string; command: string; repository: string; number: number }

/** Record the explicit write authorization of one accepted `needsWrite` command run; returns its id. */
export async function createPluginCommandWriteGrant(database: Knex, scope: PluginCommandWriteGrantScope & { actor: string; servers: string[] }, now: number = Date.now()): Promise<string> {
  const id = randomUUID();
  await database('plugin_command_write_grants').where('expires_at', '<=', now).delete();
  await database('plugin_command_write_grants').insert({
    id, plugin_id: scope.pluginId, command: scope.command, repository: scope.repository.toLowerCase(), number: scope.number, actor: scope.actor,
    servers: JSON.stringify(scope.servers), created_at: now, expires_at: now + PLUGIN_COMMAND_WRITE_GRANT_TTL_MS,
  });
  return id;
}

/**
 * Consume a write grant for the run starting now: the write servers it
 * covers, or null when it was already consumed (a retry or a later run), has
 * expired, or was made for another command run. Single use: of concurrent
 * callers only one gets the servers.
 */
export async function consumePluginCommandWriteGrant(database: Knex, id: unknown, scope: PluginCommandWriteGrantScope & { taskId: string }, now: number = Date.now()): Promise<string[] | null> {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) return null;
  const where = { id, plugin_id: scope.pluginId, command: scope.command, repository: scope.repository.toLowerCase(), number: scope.number };
  const updated = await database('plugin_command_write_grants').where(where).whereNull('consumed_at').where('expires_at', '>', now)
    .update({ consumed_at: now, consumed_by: scope.taskId.slice(0, 255) });
  if (updated !== 1) return null;
  const row = await database('plugin_command_write_grants').where({ id }).first('servers') as { servers: string } | undefined;
  try {
    const servers: unknown = JSON.parse(row?.servers ?? '[]');
    return Array.isArray(servers) ? servers.filter((s): s is string => typeof s === 'string') : [];
  } catch { return []; }
}
