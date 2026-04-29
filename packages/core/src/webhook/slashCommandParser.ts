/**
 * Slash command parser for PR comment intake.
 *
 * Recognizes `/review`, `/fix`, `/merge`, `/switch`, `/use`, and `/ultrafix` commands from PR comments.
 * Splits the comment into command name, arguments, and trailing multiline instructions.
 */

export type SlashCommandName = 'review' | 'fix' | 'merge' | 'switch' | 'use' | 'ultrafix';

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

export interface SwitchCommandMeta {
    mode: 'switch';
    /** Target model labels to switch to permanently */
    models: string[];
    /** Extra instructions from lines below the command */
    instructions: string;
    /** Warning message if extra arguments were ignored */
    warning?: string;
}

export interface UseCommandMeta {
    mode: 'use';
    /** Target model labels for single-run override */
    models: string[];
    /** Extra instructions from lines below the command */
    instructions: string;
    /** Warning message if extra arguments were ignored */
    warning?: string;
}

export interface UltrafixCommandMeta {
    mode: 'ultrafix';
    /** Target number of passing review cycles (undefined = not provided, use DB default) */
    goal?: number;
    /** Maximum fix cycles before giving up (undefined = not provided, use DB default) */
    maxCycles?: number;
    /** Seconds to pause between cycles (undefined = not provided, use DB default) */
    pauseSeconds?: number;
    /** Model to use for review cycles (undefined = not provided, use DB default) */
    reviewModel?: string;
    /** Extra instructions from lines below the command */
    instructions: string;
    /** Warning message if unknown keys were encountered */
    warning?: string;
}

export type CommandMeta = ReviewCommandMeta | FixCommandMeta | MergeCommandMeta | SwitchCommandMeta | UseCommandMeta | UltrafixCommandMeta;

const SLASH_COMMAND_REGEX = /^\/(?<cmd>review|fix|merge|switch|use|ultrafix)(?:[\s\t]+(?<rest>.*))?[\r]?$/;

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
 * For `/switch`: extracts single model target and optional instructions.
 * For `/use`: extracts single model for one-time override and optional instructions.
 * For `/ultrafix`: parses positional goal or named key=value arguments.
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
        case 'switch': {
            const switchModel = parsed.args.length > 0 ? [normalizeModelLabel(parsed.args[0])] : [];
            const switchMeta: SwitchCommandMeta = {
                mode: 'switch',
                models: switchModel,
                instructions: parsed.instructions,
            };
            if (parsed.args.length > 1) {
                switchMeta.warning = `/switch accepts only one model argument; extra arguments were ignored: ${parsed.args.slice(1).join(', ')}`;
            }
            return switchMeta;
        }
        case 'use': {
            const useModel = parsed.args.length > 0 ? [normalizeModelLabel(parsed.args[0])] : [];
            const useMeta: UseCommandMeta = {
                mode: 'use',
                models: useModel,
                instructions: parsed.instructions,
            };
            if (parsed.args.length > 1) {
                useMeta.warning = `/use accepts only one model argument; extra arguments were ignored: ${parsed.args.slice(1).join(', ')}`;
            }
            return useMeta;
        }
        case 'ultrafix': {
            return parseUltrafixArgs(parsed);
        }
    }
}

const ULTRAFIX_KNOWN_KEYS = new Set(['goal', 'max', 'pause', 'model']);

/** Parse a string as a positive integer, or return undefined. */
function parsePositiveInt(value: string, allowZero = false): number | undefined {
    const n = Number(value);
    if (Number.isNaN(n) || !Number.isFinite(n) || !Number.isInteger(n)) return undefined;
    return allowZero ? (n >= 0 ? n : undefined) : (n > 0 ? n : undefined);
}

/** Apply a single key=value pair to the ultrafix meta object. Returns an error string if invalid, or undefined on success. */
function applyUltrafixKeyValue(meta: UltrafixCommandMeta, key: string, value: string): string | undefined {
    switch (key) {
        case 'goal': {
            const n = parsePositiveInt(value);
            if (n === undefined || n < 1 || n > 10) return `goal must be an integer between 1 and 10, got '${value}'`;
            meta.goal = n;
            return undefined;
        }
        case 'max': {
            const n = parsePositiveInt(value);
            if (n === undefined || n < 1) return `max must be a positive integer, got '${value}'`;
            meta.maxCycles = n;
            return undefined;
        }
        case 'pause': {
            const n = parsePositiveInt(value, true);
            if (n === undefined) return `pause must be a non-negative integer, got '${value}'`;
            meta.pauseSeconds = n;
            return undefined;
        }
        case 'model':
            meta.reviewModel = normalizeModelLabel(value);
            return undefined;
        default:
            return undefined;
    }
}

/**
 * Parse `/ultrafix` arguments supporting positional and key=value forms.
 *
 * - `/ultrafix` → all defaults
 * - `/ultrafix 8` → goal=8
 * - `/ultrafix goal=8 max=10 pause=60 model=claude-sonnet-4-6`
 */
function parseUltrafixArgs(parsed: ParsedSlashCommand): UltrafixCommandMeta {
    const meta: UltrafixCommandMeta = {
        mode: 'ultrafix',
        instructions: parsed.instructions,
    };

    const warnings: string[] = [];
    let hasNamedArgs = false;
    let hasPositionalGoal = false;

    for (let i = 0; i < parsed.args.length; i++) {
        const arg = parsed.args[i];
        const eqIdx = arg.indexOf('=');
        if (eqIdx !== -1) {
            const key = arg.substring(0, eqIdx).toLowerCase();
            const value = arg.substring(eqIdx + 1);

            if (hasPositionalGoal) {
                warnings.push('Mixed positional and named arguments; positional goal was overridden by named arguments');
                hasPositionalGoal = false;
            }
            hasNamedArgs = true;

            if (ULTRAFIX_KNOWN_KEYS.has(key)) {
                const err = applyUltrafixKeyValue(meta, key, value);
                if (err) warnings.push(err);
            } else {
                warnings.push(`Unknown key '${key}' ignored`);
            }
        } else if (!hasNamedArgs && i === 0) {
            const n = parsePositiveInt(arg);
            if (n === undefined || n < 1 || n > 10) {
                warnings.push(`Invalid positional goal '${arg}'; must be an integer between 1 and 10`);
            } else {
                meta.goal = n;
                hasPositionalGoal = true;
            }
        } else {
            warnings.push(`Extra argument '${arg}' ignored`);
        }
    }

    if (warnings.length > 0) {
        meta.warning = warnings.join('; ');
    }

    return meta;
}
