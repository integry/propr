import type { Knex } from 'knex';
import {
  COMMAND_NAME_PATTERN, isBuiltInCommandName, parseCommandLine, pluginCommandInstruction,
  type CommandTarget, type ExtensionLibraryRevision, type PluginCommand, type PluginManifest,
} from '@propr/shared';
import logger from '../utils/logger.js';
import { officialPluginCatalog, type PluginCatalogSource } from './pluginCatalog.js';
import { installationRecord, type PluginInstallationRow } from './pluginState.js';

/**
 * Slash commands contributed by plugins (`contributes.commands`), resolved
 * where issue and pull request comments are classified. Built-in commands are
 * parsed first and always win; a comment is a plugin command only when its
 * name is not built in and exactly one enabled plugin, limited to (or not
 * limited away from) the comment's repository, contributes it for that kind
 * of comment. Anything else, a disabled or uninstalled plugin's command
 * included, is an unknown command and keeps today's behaviour.
 */

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
}

export type PluginCommandResolution =
  | { status: 'none' }
  | { status: 'refused'; pluginId: string; pluginName: string; command: string; message: string }
  | { status: 'resolved'; run: PluginCommandRun };

export interface PluginCommandRequest {
  body: string | null | undefined;
  /** `owner/repo` of the comment. */
  repository: string;
  target: CommandTarget;
  /** GitHub login of the comment's author, named in the instruction. */
  author?: string;
}

export interface PluginCommandDependencies {
  database: Knex;
  catalog?: PluginCatalogSource;
  /** The extension library's current items; defaults to the library head. */
  library?: () => Promise<Pick<ExtensionLibraryRevision, 'servers' | 'skills'>>;
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

/** Resolve one comment against the enabled plugins' commands. */
export async function resolvePluginCommand(request: PluginCommandRequest, deps: PluginCommandDependencies): Promise<PluginCommandResolution> {
  const name = candidatePluginCommandName(request.body);
  if (!name) return { status: 'none' };
  const rows = await deps.database('plugin_installations').where({ enabled: true }).select() as PluginInstallationRow[];
  if (!rows.length) return { status: 'none' };
  const installations = rows.map(row => ({ pluginId: row.plugin_id, repositories: installationRecord(row).repositories }));
  const matches = applicablePluginCommands(await (deps.catalog ?? officialPluginCatalog)(), installations, { name, repository: request.repository, target: request.target });
  if (matches.length !== 1) {
    // Enabling refuses a second plugin with the same command; should two ever be enabled, neither runs.
    if (matches.length > 1) logger.warn({ command: name, plugins: matches.map(m => m.manifest.id) }, '[plugins] Command contributed by more than one enabled plugin; ignored');
    return { status: 'none' };
  }
  const [{ manifest, command }] = matches;
  if (command.needsWrite) {
    return {
      status: 'refused', pluginId: manifest.id, pluginName: manifest.name, command: name,
      message: `/${name} of the ${manifest.name} plugin needs write access, which plugin commands cannot have yet. Nothing was started.`,
    };
  }
  const library = deps.library ? await deps.library() : await defaultLibrary(deps.database);
  const argument = parseCommandLine(request.body)!.argument;
  return {
    status: 'resolved',
    run: {
      pluginId: manifest.id, pluginName: manifest.name, command: name, kind: command.kind,
      instruction: pluginCommandInstruction({ pluginName: manifest.name, command: name, prompt: command.prompt, argument, author: request.author }),
      extensions: pluginCommandExtensions(manifest.id, command, library),
    },
  };
}

async function defaultLibrary(database: Knex): Promise<Pick<ExtensionLibraryRevision, 'servers' | 'skills'>> {
  const { ExtensionLibraryStore } = await import('../extensions/extensionProfileStore.js');
  return (await new ExtensionLibraryStore(database).head()).snapshot;
}

/** Why enabling `manifest` would make a command ambiguous: a built-in name, or a command another enabled plugin contributes. */
export function pluginCommandConflicts(manifest: PluginManifest, enabled: readonly PluginManifest[]): string[] {
  const problems: string[] = [];
  for (const command of manifest.contributes.commands) {
    if (isBuiltInCommandName(command.name)) { problems.push(`Command /${command.name} is a built-in ProPR command`); continue; }
    const other = enabled.find(m => m.id !== manifest.id && m.contributes.commands.some(c => c.name === command.name));
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
    const help: PluginCommandHelp[] = [];
    for (const row of rows) {
      if (!inScope(installationRecord(row).repositories, input.repository)) continue;
      const manifest = manifests.find(m => m.id === row.plugin_id);
      for (const command of manifest?.contributes.commands ?? []) {
        if (command.where.includes(input.target)) help.push({ name: command.name, description: command.description, pluginId: manifest!.id, pluginName: manifest!.name });
      }
    }
    // A name two enabled plugins share runs for neither, so it is not offered.
    return help.filter(item => help.filter(other => other.name === item.name).length === 1).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
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
