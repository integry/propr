import type { Knex } from 'knex';
import {
  COMMAND_NAME_PATTERN, isBuiltInCommandName, parseCommandLine, pluginCommandInstruction, pluginSharedCommandSiblings,
  type CommandTarget, type ExtensionLibraryRevision, type PluginCommand, type PluginManifest,
} from '@propr/shared';
import logger from '../utils/logger.js';
import { officialPluginCatalog, type PluginCatalogSource } from './pluginCatalog.js';
import { installationRecord, type PluginInstallationRow } from './pluginState.js';
import { commandKey, createPluginCommandWriteGrant, readPluginCommandAccess, type PluginCommandAccess } from './pluginCommandSettings.js';

/**
 * Slash commands contributed by plugins (`contributes.commands`), resolved
 * where issue and pull request comments are classified. Built-in commands are
 * parsed first and always win; a comment is a plugin command only when its
 * name is not built in and an enabled plugin, limited to (or not limited away
 * from) the comment's repository, contributes it for that kind of comment.
 * Several enabled plugins may offer one name only when each marks it
 * `shared`: the plain name then runs the plugin an administrator chose (the
 * only enabled one without a choice), or replies naming the specific
 * commands. Anything else, a disabled or uninstalled plugin's command
 * included, is an unknown command and keeps today's behaviour.
 *
 * A `needsWrite` command runs only when an administrator allowed it write
 * access and the commenter has write permission on the repository; it then
 * carries a single-use write grant for its run. A `handler` command resolves
 * to a delivery of its plugin's handler instead of a task.
 */

/** The explicit write authorization a `needsWrite` command run carries: consumed once, by the run it was made for. */
export interface PluginCommandWriteGrant {
  /** The `plugin_command_write_grants` id. */
  id: string;
  repository: string;
  number: number;
  /** The library names of the plugin's write servers the command adds. */
  servers: string[];
}

/** What a queued task carries of the plugin command that started it. */
export interface PluginCommandRun {
  pluginId: string;
  pluginName: string;
  command: string;
  kind: PluginCommand['kind'];
  /** The task's instruction: the manifest prompt with the delimited, untrusted argument. */
  instruction: string;
  /**
   * Library items to add explicitly: the managed library names of the
   * plugin's servers and the bundle ids of its skills that the manifest
   * command names. Never derived from the comment.
   */
  extensions: { servers: string[]; skills: string[] };
  /** Present for a `needsWrite` command allowed to use write access. */
  writeGrant?: PluginCommandWriteGrant;
}

/** A `handler` command to deliver to its plugin's handler. */
export interface PluginCommandDelivery { pluginId: string; pluginName: string; command: string; handler: string; argument: string }

export type PluginCommandResolution =
  | { status: 'none' }
  | { status: 'refused'; pluginId: string | null; pluginName: string | null; command: string; message: string }
  | { status: 'resolved'; run: PluginCommandRun }
  | { status: 'handler'; delivery: PluginCommandDelivery };

export interface PluginCommandRequest {
  body: string | null | undefined;
  /** `owner/repo` of the comment. */
  repository: string;
  target: CommandTarget;
  /** GitHub login of the comment's author, named in the instruction. */
  author?: string;
  /** The issue or pull request number of the comment; a write grant is bound to it. */
  number?: number;
}

/** Whether `login` has write permission (write, maintain or admin) on `repository`. */
export type RepositoryWritePermission = (repository: string, login: string) => Promise<boolean>;

export interface PluginCommandDependencies {
  database: Knex;
  catalog?: PluginCatalogSource;
  /** The extension library's current items; defaults to the library head. */
  library?: () => Promise<Pick<ExtensionLibraryRevision, 'servers' | 'skills'>>;
  /** Defaults to the GitHub collaborator permission of the commenter. */
  writePermission?: RepositoryWritePermission;
  now?: () => number;
}

/** An enabled installation as command resolution sees it. */
export interface CommandInstallation { pluginId: string; repositories: readonly string[] | null }

const lower = (value: string) => value.toLowerCase();
const inScope = (repositories: readonly string[] | null, repository: string) => !repositories || !repositories.length || repositories.map(lower).includes(lower(repository));

/** The command name a comment names, when it could be a plugin command at all: no database read otherwise. */
export function candidatePluginCommandName(body: string | null | undefined): string | null {
  const line = parseCommandLine(body);
  if (!line || isBuiltInCommandName(line.name) || !COMMAND_NAME_PATTERN.test(line.name)) return null;
  return line.name;
}

/**
 * The plugin commands that apply to one comment: commands named `name` of
 * enabled installations whose repository limit includes `repository` and
 * that are declared for `target`. Pure, for the intake and its tests.
 */
export function applicablePluginCommands(
  manifests: readonly PluginManifest[], installations: readonly CommandInstallation[],
  match: { name: string; repository: string; target: CommandTarget },
): { manifest: PluginManifest; command: PluginCommand }[] {
  const found: { manifest: PluginManifest; command: PluginCommand }[] = [];
  for (const installation of installations) {
    if (!inScope(installation.repositories, match.repository)) continue;
    const manifest = manifests.find(m => m.id === installation.pluginId);
    const command = manifest?.contributes.commands.find(c => c.name === match.name);
    if (manifest && command && command.where.includes(match.target)) found.push({ manifest, command });
  }
  return found;
}

/** The library names of the managed items a command adds, from its plugin's managed items only. */
export function pluginCommandExtensions(pluginId: string, command: PluginCommand, library: Pick<ExtensionLibraryRevision, 'servers' | 'skills'>): PluginCommandRun['extensions'] {
  const owned = <T extends { managedBy?: { plugin: string; item: string } }>(items: readonly T[], name: string) => items.find(item => item.managedBy?.plugin === pluginId && item.managedBy.item === name);
  return {
    servers: command.servers.flatMap(name => { const item = owned(library.servers, name); return item ? [item.name] : []; }),
    skills: command.skills.flatMap(name => { const item = owned(library.skills, name); return item ? [item.bundleId] : []; }),
  };
}

/** The library names of the plugin's write servers a command adds: what its write grant covers. */
export function pluginCommandWriteServers(pluginId: string, command: PluginCommand, library: Pick<ExtensionLibraryRevision, 'servers'>): string[] {
  return command.servers.flatMap(name => {
    const item = library.servers.find(s => s.managedBy?.plugin === pluginId && s.managedBy.item === name);
    return item && item.capability === 'write' ? [item.name] : [];
  });
}

type Match = { manifest: PluginManifest; command: PluginCommand };

/** The reply to a shared name several enabled plugins offer here without an owner among them: it names their specific commands. */
export function sharedCommandChoiceMessage(name: string, matches: readonly Match[], target: CommandTarget): string {
  const options = matches.map(({ manifest, command }) => {
    const specific = pluginSharedCommandSiblings(manifest.contributes.commands, command).filter(c => c.where.includes(target)).map(c => `/${c.name}`);
    return `${specific.join(' or ') || `a specific command of ${manifest.name}`} (${manifest.name})`;
  });
  return `/${name} is offered by more than one plugin here: use ${options.join(', ')} instead. An administrator can choose which plugin /${name} runs on the Plugins page. Nothing was started.`;
}

/**
 * The one command a name runs: the only match, or among shared matches the
 * owner an administrator chose. `ambiguous` when several plugins share the
 * name and none of them is the owner; null when the name is not shared by
 * all of them (enabling refuses that; should it happen, nothing runs).
 */
export function choosePluginCommand(matches: readonly Match[], owner: string | undefined): Match | 'ambiguous' | null {
  if (matches.length === 1) return matches[0];
  if (!matches.length || !matches.every(m => m.command.shared)) return null;
  return matches.find(m => m.manifest.id === owner) ?? 'ambiguous';
}

/** The default write permission check: the commenter's collaborator permission on the repository. */
export const githubWritePermission: RepositoryWritePermission = async (repository, login) => {
  const [owner, repo] = repository.split('/');
  const { getAuthenticatedOctokit } = await import('../auth/githubAuth.js');
  const octokit = await getAuthenticatedOctokit() as unknown as { request(route: string, parameters: Record<string, unknown>): Promise<{ data: { permission?: string } }> };
  try {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/collaborators/{username}/permission', { owner, repo, username: login });
    return data.permission === 'admin' || data.permission === 'write' || data.permission === 'maintain';
  } catch (error) {
    // Not a collaborator.
    if ((error as { status?: number }).status === 404 || (error as { status?: number }).status === 403) return false;
    throw error;
  }
};

/** Why a `needsWrite` command may not run for this comment, or null when it may. */
async function writeRefusal(request: PluginCommandRequest, match: Match, access: PluginCommandAccess, deps: PluginCommandDependencies): Promise<string | null> {
  const { manifest, command } = match;
  const who = `/${command.name} of the ${manifest.name} plugin needs write access`;
  if (!access.writeAllowed.has(commandKey(manifest.id, command.name))) {
    return `${who}, and an administrator has not allowed it: "Allow this command to use write access" is off for /${command.name} on the Plugins page. Nothing was started.`;
  }
  if (!request.author || request.number === undefined) return `${who}, and ProPR could not tell who ran it. Nothing was started.`;
  if (!await (deps.writePermission ?? githubWritePermission)(request.repository, request.author)) {
    return `${who}: only people with write permission on ${request.repository} can run it. Nothing was started.`;
  }
  return null;
}

/** Resolve one comment against the enabled plugins' commands. */
export async function resolvePluginCommand(request: PluginCommandRequest, deps: PluginCommandDependencies): Promise<PluginCommandResolution> {
  const name = candidatePluginCommandName(request.body);
  if (!name) return { status: 'none' };
  const rows = await deps.database('plugin_installations').where({ enabled: true }).select() as PluginInstallationRow[];
  if (!rows.length) return { status: 'none' };
  const installations = rows.map(row => ({ pluginId: row.plugin_id, repositories: installationRecord(row).repositories }));
  const matches = applicablePluginCommands(await (deps.catalog ?? officialPluginCatalog)(), installations, { name, repository: request.repository, target: request.target });
  if (!matches.length) return { status: 'none' };
  const access = await readPluginCommandAccess(deps.database);
  const chosen = choosePluginCommand(matches, access.owners.get(name));
  if (chosen === 'ambiguous') return { status: 'refused', pluginId: null, pluginName: null, command: name, message: sharedCommandChoiceMessage(name, matches, request.target) };
  if (!chosen) {
    // Enabling refuses a second plugin with the same unshared command; should two ever be enabled, neither runs.
    logger.warn({ command: name, plugins: matches.map(m => m.manifest.id) }, '[plugins] Command contributed by more than one enabled plugin; ignored');
    return { status: 'none' };
  }
  const { manifest, command } = chosen;
  const argument = parseCommandLine(request.body)!.argument;
  if (command.kind === 'handler') {
    return { status: 'handler', delivery: { pluginId: manifest.id, pluginName: manifest.name, command: name, handler: command.handler!, argument } };
  }
  if (command.needsWrite) {
    const message = await writeRefusal(request, chosen, access, deps);
    if (message) return { status: 'refused', pluginId: manifest.id, pluginName: manifest.name, command: name, message };
  }
  const library = deps.library ? await deps.library() : await defaultLibrary(deps.database);
  const run: PluginCommandRun = {
    pluginId: manifest.id, pluginName: manifest.name, command: name, kind: command.kind,
    instruction: pluginCommandInstruction({ pluginName: manifest.name, command: name, prompt: command.prompt ?? '', argument, author: request.author }),
    extensions: pluginCommandExtensions(manifest.id, command, library),
  };
  if (command.needsWrite) {
    const servers = pluginCommandWriteServers(manifest.id, command, library);
    const scope = { pluginId: manifest.id, command: name, repository: request.repository, number: request.number! };
    const id = await createPluginCommandWriteGrant(deps.database, { ...scope, actor: request.author!, servers }, deps.now?.());
    run.writeGrant = { id, repository: request.repository, number: request.number!, servers };
  }
  return { status: 'resolved', run };
}

async function defaultLibrary(database: Knex): Promise<Pick<ExtensionLibraryRevision, 'servers' | 'skills'>> {
  const { ExtensionLibraryStore } = await import('../extensions/extensionProfileStore.js');
  return (await new ExtensionLibraryStore(database).head()).snapshot;
}

/**
 * Why enabling `manifest` would make a command ambiguous: a built-in name, or
 * a command another enabled plugin contributes, unless both mark it shared.
 */
export function pluginCommandConflicts(manifest: PluginManifest, enabled: readonly PluginManifest[]): string[] {
  const problems: string[] = [];
  for (const command of manifest.contributes.commands) {
    if (isBuiltInCommandName(command.name)) { problems.push(`Command /${command.name} is a built-in ProPR command`); continue; }
    const other = enabled.find(m => m.id !== manifest.id && m.contributes.commands.some(c => c.name === command.name && !(c.shared && command.shared)));
    if (other) problems.push(`Command /${command.name} is also contributed by the enabled plugin ${other.name} (${other.id}); disable that plugin first`);
  }
  return problems;
}

/** A plugin command as the in-product command help lists it. */
export interface PluginCommandHelp { name: string; description: string; pluginId: string; pluginName: string }

/**
 * The commands enabled plugins offer in `repository` for `target`, for the
 * command help next to the built-in commands. Empty when the plugin state
 * cannot be read: help never fails the comment it is part of.
 */
export async function listPluginCommandHelp(input: { repository: string; target: CommandTarget }, deps?: Pick<PluginCommandDependencies, 'database' | 'catalog'>): Promise<PluginCommandHelp[]> {
  try {
    const database = deps?.database ?? (await import('../db/connection.js')).db;
    const rows = await database('plugin_installations').where({ enabled: true }).select() as PluginInstallationRow[];
    if (!rows.length) return [];
    const manifests = await (deps?.catalog ?? officialPluginCatalog)();
    const matches: Match[] = [];
    for (const row of rows) {
      if (!inScope(installationRecord(row).repositories, input.repository)) continue;
      const manifest = manifests.find(m => m.id === row.plugin_id);
      for (const command of manifest?.contributes.commands ?? []) if (command.where.includes(input.target)) matches.push({ manifest: manifest!, command });
    }
    const owners = matches.some(m => m.command.shared) ? (await readPluginCommandAccess(database)).owners : new Map<string, string>();
    const help: PluginCommandHelp[] = [];
    for (const name of [...new Set(matches.map(m => m.command.name))].sort()) {
      // A name that runs nothing here (unshared and offered twice, or shared without an owner among several) is not offered.
      const chosen = choosePluginCommand(matches.filter(m => m.command.name === name), owners.get(name));
      if (chosen && chosen !== 'ambiguous') help.push({ name, description: chosen.command.description, pluginId: chosen.manifest.id, pluginName: chosen.manifest.name });
    }
    return help;
  } catch (error) {
    logger.warn({ repository: input.repository, error: error instanceof Error ? error.message : String(error) }, '[plugins] Could not list plugin commands for the command help');
    return [];
  }
}

export type PluginCommandResolver = (request: PluginCommandRequest) => Promise<PluginCommandResolution>;
let resolver: PluginCommandResolver | null = null;

/** Replace the resolver comment intake uses (tests), or restore the default with null. */
export function setPluginCommandResolver(next: PluginCommandResolver | null): void { resolver = next; }

/**
 * The resolution comment intake uses. A comment that cannot name a plugin
 * command costs nothing. When the plugin state cannot be read the command is
 * treated as unknown, as it would have been before plugins.
 */
export async function resolveCommentPluginCommand(request: PluginCommandRequest): Promise<PluginCommandResolution> {
  if (!candidatePluginCommandName(request.body)) return { status: 'none' };
  try {
    if (resolver) return await resolver(request);
    const { db } = await import('../db/connection.js');
    return await resolvePluginCommand(request, { database: db });
  } catch (error) {
    logger.warn({ repository: request.repository, target: request.target, error: error instanceof Error ? error.message : String(error) }, '[plugins] Could not resolve a plugin command; treating it as unknown');
    return { status: 'none' };
  }
}
