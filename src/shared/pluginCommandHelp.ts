import type { CommandTarget } from '@propr/shared';
import type { PluginCommandHelpRow } from './slashCommandsBlock.js';

/**
 * The commands enabled plugins offer in a repository, for the slash command
 * help in ProPR's comments. Loaded on use from Core, so modules whose tests
 * enumerate the Core exports they mock need no new export; empty when the
 * lookup is unavailable or fails, so help never fails a comment.
 */
export async function enabledPluginCommandHelp(repository: string, target: CommandTarget): Promise<PluginCommandHelpRow[]> {
    try {
        const core = await import('@propr/core') as { listPluginCommandHelp?: (input: { repository: string; target: CommandTarget }) => Promise<PluginCommandHelpRow[]> };
        return typeof core.listPluginCommandHelp === 'function' ? await core.listPluginCommandHelp({ repository, target }) : [];
    } catch {
        return [];
    }
}
