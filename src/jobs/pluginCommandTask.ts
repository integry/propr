/**
 * How a task started by a plugin `prompt` command differs from an ordinary
 * one: its instruction comes from the plugin manifest (the comment's argument
 * delimited inside it, as untrusted text) and the plugin's named skills and
 * servers are added explicitly to the run's extension request. Both were
 * resolved at intake from the manifest alone; nothing here reads the comment.
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

/** The request a pull request follow-up carries out: the command's instruction, or the comments otherwise. */
export function pluginCommandRequestText(run: PluginCommandRun | undefined, comments: string): string {
  return run ? run.instruction : comments;
}

/** The section an issue task's prompt ends with when a plugin command started it; empty otherwise. */
export function pluginCommandIssuePrompt(run: PluginCommandRun | undefined): string {
  if (!run) return '';
  return ['## Requested with a plugin command', '', 'Carry out this request as part of implementing the issue.', '', run.instruction].join('\n');
}
