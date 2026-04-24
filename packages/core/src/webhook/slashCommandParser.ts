/**
 * Slash command parser for PR comment intake.
 *
 * Recognizes `/review`, `/fix`, and `/merge` commands from PR comments.
 * Splits the comment into command name, arguments, and trailing multiline instructions.
 */

export type SlashCommandName = 'review' | 'fix' | 'merge';

export interface ParsedSlashCommand {
    /** The recognized command */
    command: SlashCommandName;
    /** Raw arguments on the command line (e.g. model labels for /review) */
    args: string[];
    /** Trailing multiline text after the command line, used as extra instructions */
    instructions: string;
}

export interface ReviewCommandMeta {
    mode: 'review';
    /** Requested model labels, normalized (llm- prefix stripped if present) */
    models: string[];
    /** Extra review instructions from lines below the command */
    instructions: string;
}

export interface FixCommandMeta {
    mode: 'fix';
    /** Extra fix instructions from the command line and body */
    instructions: string;
}

export interface MergeCommandMeta {
    mode: 'merge';
}

export type CommandMeta = ReviewCommandMeta | FixCommandMeta | MergeCommandMeta;

const SLASH_COMMAND_REGEX = /^\/(?<cmd>review|fix|merge)(?:\s+(?<rest>.*))?$/;

/**
 * Parse a PR comment body for a slash command.
 *
 * Returns null if the comment does not start with a recognized slash command.
 * The first line is parsed for command + arguments; remaining lines become instructions.
 */
export function parseSlashCommand(body: string | undefined | null): ParsedSlashCommand | null {
    if (!body) return null;

    // Check the raw first line — comments with leading blank lines should not count as slash commands
    const firstNewline = body.indexOf('\n');
    const rawFirstLine = firstNewline === -1 ? body : body.substring(0, firstNewline);
    const firstLineTrimmed = rawFirstLine.trim();

    if (!firstLineTrimmed.startsWith('/')) return null;

    const match = firstLineTrimmed.match(SLASH_COMMAND_REGEX);
    if (!match?.groups) return null;

    const command = match.groups.cmd as SlashCommandName;
    const argsStr = match.groups.rest?.trim() ?? '';
    const args = argsStr ? argsStr.split(/\s+/) : [];
    const rest = firstNewline === -1 ? '' : body.substring(firstNewline + 1).trim();

    return { command, args, instructions: rest };
}

/**
 * Normalize a model label by stripping the `llm-` prefix if present.
 */
function normalizeModelLabel(label: string): string {
    return label.startsWith('llm-') ? label.substring(4) : label;
}

/**
 * Build structured command metadata from a parsed slash command.
 *
 * For `/review`: normalizes model labels and captures instructions.
 * For `/fix`: captures everything after `/fix` as instructions.
 * For `/merge`: returns a simple merge marker.
 */
export function buildCommandMeta(parsed: ParsedSlashCommand): CommandMeta {
    switch (parsed.command) {
        case 'review':
            return {
                mode: 'review',
                models: parsed.args.map(normalizeModelLabel),
                instructions: parsed.instructions,
            };
        case 'fix': {
            // For /fix, args on the command line are also instructions
            const parts = [parsed.args.join(' '), parsed.instructions].filter(Boolean);
            return {
                mode: 'fix',
                instructions: parts.join('\n').trim(),
            };
        }
        case 'merge':
            return { mode: 'merge' };
    }
}
