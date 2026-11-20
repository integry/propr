/**
 * How a task started by a plugin `prompt` command differs from an ordinary
 * one: its instruction comes from the plugin manifest (the comment's argument
 * delimited inside it, as untrusted text) and the plugin's named skills and
 * servers are added explicitly to the run's extension request. Both were
 * resolved at intake from the manifest alone; nothing here reads the comment.
 *
 * An allowed `needsWrite` command carries a write grant: the run consumes it
 * as it starts, and only then is it authorized to use the plugin's write
 * servers that the command names (no other write server). The grant is single
 * use, so a retry of the run or a later follow-up gets read servers only.
 */
import type { PluginCommandRun } from '@propr/core';
import type { TaskRunExtensionRequest } from '@propr/shared';

/**
 * The extension request base of a run: `base` (a legacy submission's request,
 * or none) with the command's library items added explicitly. Unchanged
 * without a command. Write authorization is never added here.
 */
export function pluginCommandExtensionBase(run: PluginCommandRun | undefined, base?: TaskRunExtensionRequest): TaskRunExtensionRequest | undefined {
  if (!run) return base;
  const start = base ?? { autoApply: true, servers: [], skills: [] };
  return {
    ...start,
    servers: [...new Set([...start.servers, ...run.extensions.servers])],
    skills: [...new Set([...start.skills, ...run.extensions.skills])],
  };
}

export interface PluginCommandWriteGrantDeps {
  /** Consume the run's write grant; defaults to the instance database's grants. */
  consume?: (run: PluginCommandRun, taskId: string) => Promise<string[] | null>;
  logger?: { info(fields: object, message: string): void; warn(fields: object, message: string): void };
}

// Loaded only for a run that carries a grant: suites that mock Core with an enumerated export list never load it.
const core = () => import('@propr/core');
const consumeGrant = async (run: PluginCommandRun, taskId: string) => {
  const { consumePluginCommandWriteGrant, db } = await core();
  return consumePluginCommandWriteGrant(db, run.writeGrant!.id, {
    pluginId: run.pluginId, command: run.command, repository: run.writeGrant!.repository, number: run.writeGrant!.number, taskId,
  });
};

/**
 * `pluginCommandExtensionBase`, with the command's write grant consumed for
 * this run (`taskId`): when it is still unused the request is authorized to
 * use exactly the plugin's write servers it covers. A grant already consumed
 * (a retry, a later follow-up), expired or unreadable leaves the run with
 * read servers only. A base already authorized for every write server (a New
 * Task write submission) keeps that authorization.
 */
export async function pluginCommandRunExtensionBase(run: PluginCommandRun | undefined, base: TaskRunExtensionRequest | undefined, taskId: string, deps: PluginCommandWriteGrantDeps = {}): Promise<TaskRunExtensionRequest | undefined> {
  const request = pluginCommandExtensionBase(run, base);
  if (!run?.writeGrant || !request) return request;
  const { logger } = deps.logger ? { logger: deps.logger } : await core();
  let servers: string[] | null = null;
  try {
    servers = await (deps.consume ?? consumeGrant)(run, taskId);
  } catch (error) {
    logger.warn({ taskId, plugin: run.pluginId, command: run.command, error: error instanceof Error ? error.message : String(error) }, 'Could not read the plugin command\'s write grant; the run gets read servers only');
  }
  if (!servers) {
    logger.info({ taskId, plugin: run.pluginId, command: run.command }, 'The plugin command\'s write grant was already used or has expired; the run gets read servers only');
    return request;
  }
  if (request.allowWrite === true && !request.writeServers) return request;
  return { ...request, allowWrite: true, writeServers: [...new Set([...(request.writeServers ?? []), ...servers])] };
}

/** The request a pull request follow-up carries out: the command's instruction, or the comments otherwise. */
export function pluginCommandRequestText(run: PluginCommandRun | undefined, comments: string): string {
  return run ? run.instruction : comments;
}

/** The section an issue task's prompt ends with when a plugin command started it; empty otherwise. */
export function pluginCommandIssuePrompt(run: PluginCommandRun | undefined): string {
  if (!run) return '';
  return ['## Requested with a plugin command', '', 'Carry out this request as part of implementing the issue.', '', run.instruction].join('\n');
}
