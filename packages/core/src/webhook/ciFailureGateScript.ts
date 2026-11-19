/**
 * Recognizes the shell script of a result-enforcement step: one whose failure
 * can only come from the values it was given, never from the job's own work.
 *
 * Running only builtins is not enough. `test -f dist/bundle.js` is a builtin,
 * yet it fails on a missing artifact, whatever the needed jobs' results were.
 * So the script must also:
 *  - compare, in every `test`, `[` and `[[`, only values traced to the step's
 *    `env` (whose expressions were checked to read only needed jobs' results
 *    and outputs, the `github` context or literals), literals, variables
 *    assigned from those, and the arguments of its own functions when every
 *    call passes such values; with string and integer operators only, so no
 *    file, permission or option test; and with no unquoted glob, which would
 *    read the file system;
 *  - fail only under such a condition: an `exit 1`, `return 1`, `false`, or a
 *    call of a function that fails unconditionally, must sit inside an `if`
 *    whose condition is such tests, or follow one through `&&` or `||`;
 *    `exit "$status"` counts as unconditional when `status` is set to a
 *    nonzero literal outside such a condition;
 *  - redirect output only to the step summary, `GITHUB_OUTPUT`, `GITHUB_ENV`,
 *    `/dev/null`, the standard streams, or another descriptor, and read no
 *    input.
 * Pipelines, background jobs, subshells, loops, `case`, command substitution
 * and anything else this reader does not follow make the script not a gate.
 */

import { splitCommands, type ShellCommand } from './ciFailureShellLexer.js';

const TEST_COMMANDS: Record<string, string | null> = { test: null, '[': ']', '[[': ']]' };
const TEST_OPERATORS = new Set(['=', '==', '!=', '!', '-z', '-n', '-eq', '-ne', '-lt', '-le', '-gt', '-ge', '=~']);
const ASSIGNMENT_RE = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/u;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const REDIRECT_RE = /^(\d*)(>>|>&|>\||>|&>>|&>|<&|<>|<)([\s\S]*)$/u;
const REDIRECT_TARGETS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr']);
const REDIRECT_VARIABLE_RE = /^\$\{?(GITHUB_STEP_SUMMARY|GITHUB_OUTPUT|GITHUB_ENV)(?::-\/dev\/null)?\}?$/u;
const EXPANSION_RE = /^(#?)([A-Za-z_][A-Za-z0-9_]*|[0-9@*#?])(?:(:?[-+])([\s\S]*))?$/u;
/** `set -e`, `+e`, `-x`, `-eo pipefail`; `-u` is not followed: an unset variable anywhere would fail the step. */
const SET_FLAG_RE = /^[-+][ex]*(o?)$/u;
const SET_OPTIONS = new Set(['pipefail', 'errexit', 'xtrace']);
const UNSUPPORTED_SEPARATORS = new Set(['|', '&', '(', ')', ';;', '()']);
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', '{', '}', '!']);

type Frame =
    | { kind: 'if'; phase: 'cond' | 'body'; testsOnly: boolean }
    | { kind: 'fn'; name: string }
    | { kind: 'brace'; guarded: boolean };

/** What the script does with its values, checked once every variable is classified. */
interface Analysis {
    /** Words that must be traced: test operands and `printf`, `exit` and call arguments. */
    values: string[];
    assignments: Array<{ name: string; value: string; guarded: boolean }>;
    callArguments: string[];
    functionCalls: Array<{ caller: string | null; callee: string; guarded: boolean }>;
    /** `exit`, `return` and `false`, with the status word they return. */
    exits: Array<{ caller: string | null; word: string | undefined; guarded: boolean }>;
}

interface CommandContext { analysis: Analysis; functions: Set<string>; caller: string | null; guarded: boolean }

/** Whether `script` only enforces the values in `envNames`; see the module comment. */
export function enforcesOnlyResults(script: string, envNames: Set<string>): boolean {
    const commands = splitCommands(script.replace(/\$\{\{[\s\S]*?\}\}/gu, 'x'));
    if (!commands) return false;
    const functions = new Set(commands.map(functionName).filter((name): name is string => name !== null));
    const analysis = new ScriptWalker(functions).walk(commands);
    if (!analysis) return false;
    const { variables, positional } = traceVariables(analysis, envNames);
    if (!analysis.values.every(word => valueIsTraced(word, variables, positional))) return false;
    return !failsUnconditionally(analysis);
}

/** The function a `name()` or `function name` command defines. */
function functionName(command: ShellCommand): string | null {
    const named = command.words[0] === 'function';
    const words = named ? command.words.slice(1) : command.words;
    return (command.after === '()' || named) && words.length === 1 && NAME_RE.test(words[0]) ? words[0] : null;
}

/** Walks the commands in order, tracking `if`, function and brace nesting. */
class ScriptWalker {
    private readonly analysis: Analysis = { values: [], assignments: [], callArguments: [], functionCalls: [], exits: [] };
    private readonly stack: Frame[] = [];
    private pendingFunction: string | null = null;
    private previousWasTest = false;

    constructor(private readonly functions: Set<string>) {}

    /** The analysis, or null for anything this reader does not follow. */
    walk(commands: ShellCommand[]): Analysis | null {
        for (const command of commands) {
            if (!this.command(command)) return null;
        }
        return this.stack.length === 0 && !this.pendingFunction ? this.analysis : null;
    }

    private command(command: ShellCommand): boolean {
        const definition = functionName(command);
        if (UNSUPPORTED_SEPARATORS.has(command.before) || (UNSUPPORTED_SEPARATORS.has(command.after) && !definition)) return false;
        if (this.pendingFunction && command.words[0] !== '{') return false;
        if (definition) {
            this.pendingFunction = definition;
            this.previousWasTest = false;
            return true;
        }
        const chainGuarded = (command.before === '&&' || command.before === '||') && this.previousWasTest;
        let index = 0;
        while (index < command.words.length && KEYWORDS.has(command.words[index])) {
            if (!this.keyword(command.words[index], chainGuarded)) return false;
            index += 1;
        }
        const words = command.words.slice(index);
        const kind = simpleCommand(words, {
            analysis: this.analysis, functions: this.functions, caller: this.caller(), guarded: chainGuarded || this.guarded(),
        });
        if (kind === null) return false;
        const top = this.stack[this.stack.length - 1];
        if (top?.kind === 'if' && top.phase === 'cond' && words.length > 0 && kind !== 'test') top.testsOnly = false;
        this.previousWasTest = kind === 'test';
        return true;
    }

    private keyword(word: string, chainGuarded: boolean): boolean {
        const top = this.stack[this.stack.length - 1];
        const ifIn = (phase: 'cond' | 'body') => top?.kind === 'if' && top.phase === phase;
        switch (word) {
            case 'if':
                this.stack.push({ kind: 'if', phase: 'cond', testsOnly: true });
                return true;
            case 'then': case 'else': case 'elif':
                if (!ifIn(word === 'then' ? 'cond' : 'body')) return false;
                (top as { phase: string }).phase = word === 'elif' ? 'cond' : 'body';
                return true;
            case 'fi':
                return ifIn('body') && Boolean(this.stack.pop());
            case '{':
                this.stack.push(this.pendingFunction ? { kind: 'fn', name: this.pendingFunction } : { kind: 'brace', guarded: chainGuarded });
                this.pendingFunction = null;
                return true;
            case '}':
                return (top?.kind === 'fn' || top?.kind === 'brace') && Boolean(this.stack.pop());
            default:
                return true;
        }
    }

    private caller(): string | null {
        const frame = [...this.stack].reverse().find(entry => entry.kind === 'fn');
        return frame?.kind === 'fn' ? frame.name : null;
    }

    /** Inside the body of an `if` over traced tests, or a `{ }` group following one, within the current function. */
    private guarded(): boolean {
        for (let index = this.stack.length - 1; index >= 0; index -= 1) {
            const frame = this.stack[index];
            if (frame.kind === 'fn') return false;
            if ((frame.kind === 'if' && frame.phase === 'body' && frame.testsOnly) || (frame.kind === 'brace' && frame.guarded)) return true;
        }
        return false;
    }
}

/** Records one simple command; its kind, or null when it is not allowed. */
function simpleCommand(allWords: string[], context: CommandContext): 'test' | 'other' | null {
    const words = withoutRedirects(allWords);
    if (!words) return null;
    let index = 0;
    for (; index < words.length && ASSIGNMENT_RE.test(words[index]); index += 1) recordAssignment(context.analysis, words[index], context.guarded);
    if (index >= words.length) return 'other';
    const [command, ...args] = words.slice(index);
    if (command in TEST_COMMANDS) return testOperands(command, args, context.analysis) ? 'test' : null;
    return builtinAllowed(command, args, context) ? 'other' : null;
}

function builtinAllowed(command: string, args: string[], { analysis, functions, caller, guarded }: CommandContext): boolean {
    switch (command) {
        case 'echo': case 'true': case ':':
            return true;
        case 'printf':
            analysis.values.push(...args);
            return true;
        case 'false':
            analysis.exits.push({ caller, word: '1', guarded });
            return true;
        case 'exit': case 'return':
            if (args.length > 1 || (command === 'return' && caller === null)) return false;
            analysis.values.push(...args);
            analysis.exits.push({ caller, word: args[0], guarded });
            return true;
        case 'local':
            return args.every(arg => (ASSIGNMENT_RE.test(arg) ? (recordAssignment(analysis, arg, guarded), true) : NAME_RE.test(arg)));
        case 'set':
            return setOptionsAllowed(args);
        default:
            if (!functions.has(command)) return false;
            analysis.values.push(...args);
            analysis.callArguments.push(...args);
            analysis.functionCalls.push({ caller, callee: command, guarded });
            return true;
    }
}

function recordAssignment(analysis: Analysis, word: string, guarded: boolean): void {
    const [, name, value] = ASSIGNMENT_RE.exec(word) as RegExpExecArray;
    analysis.assignments.push({ name, value, guarded });
}

/** The words without their redirections; null when one reads input or writes anywhere but the allowed targets. */
function withoutRedirects(words: string[]): string[] | null {
    const kept: string[] = [];
    for (let index = 0; index < words.length; index += 1) {
        const word = words[index];
        const match = REDIRECT_RE.exec(word);
        if (!match) {
            if (/[<>]/u.test(unquoted(word))) return null;
            kept.push(word);
            continue;
        }
        const [, , operator, attached] = match;
        let target = attached;
        if (!target) {
            index += 1;
            target = words[index] ?? '';
        }
        if (!redirectAllowed(operator, target)) return null;
    }
    return kept;
}

function redirectAllowed(operator: string, target: string): boolean {
    if (operator.startsWith('<')) return false;
    if (operator === '>&') return /^(\d+|-)$/u.test(target);
    const plain = removeQuotes(target);
    return REDIRECT_TARGETS.has(plain) || REDIRECT_VARIABLE_RE.test(plain);
}

function testOperands(command: string, args: string[], analysis: Analysis): boolean {
    const close = TEST_COMMANDS[command];
    if (close !== null) {
        if (args[args.length - 1] !== close) return false;
        args = args.slice(0, -1);
    }
    for (const arg of args) {
        if (TEST_OPERATORS.has(arg)) continue;
        const plain = stripQuotes(arg);
        // A literal that `test` would read as an operator: a file, permission or option test.
        if (plain !== null && plain.startsWith('-')) return false;
        analysis.values.push(arg);
    }
    return true;
}

function setOptionsAllowed(args: string[]): boolean {
    for (let index = 0; index < args.length; index += 1) {
        const match = SET_FLAG_RE.exec(args[index]);
        if (!match || args[index].length < 2) return false;
        if (match[1]) {
            index += 1;
            if (!SET_OPTIONS.has(args[index] ?? '')) return false;
        }
    }
    return true;
}

/**
 * The variables traced to the step's values, and whether its functions'
 * arguments are: a variable stops being traced when one of its assignments
 * is not, and arguments when one call passes an untraced value.
 */
function traceVariables(analysis: Analysis, envNames: Set<string>): { variables: Set<string>; positional: boolean } {
    const variables = new Set([...envNames, ...analysis.assignments.map(assignment => assignment.name)]);
    let positional = true;
    for (let changed = true; changed;) {
        changed = false;
        for (const { name, value } of analysis.assignments) {
            if (variables.has(name) && !valueIsTraced(value, variables, positional)) {
                variables.delete(name);
                changed = true;
            }
        }
        if (positional && !analysis.callArguments.every(word => valueIsTraced(word, variables, positional))) {
            positional = false;
            changed = true;
        }
    }
    return { variables, positional };
}

/** Whether any failure happens outside a traced condition, directly or through a function. */
function failsUnconditionally(analysis: Analysis): boolean {
    const failingVariables = new Set(analysis.assignments
        .filter(({ value, guarded }) => !guarded && !/^["']?0["']?$/u.test(value) && !value.includes('$'))
        .map(({ name }) => name));
    const unconditional = (word: string | undefined) => {
        if (word === undefined) return false;
        const plain = stripQuotes(word);
        if (plain !== null) return plain !== '0';
        const name = /^"?\$\{?([A-Za-z_][A-Za-z0-9_]*|[0-9@*])\}?"?$/u.exec(word)?.[1];
        return name === undefined || !NAME_RE.test(name) || failingVariables.has(name);
    };
    const failing = new Set<string | null>();
    for (const exit of analysis.exits) {
        if (!exit.guarded && unconditional(exit.word)) failing.add(exit.caller);
    }
    for (let changed = true; changed;) {
        changed = false;
        for (const call of analysis.functionCalls) {
            if (!call.guarded && failing.has(call.callee) && !failing.has(call.caller)) {
                failing.add(call.caller);
                changed = true;
            }
        }
    }
    return failing.has(null);
}

/**
 * Whether a word's value comes only from literals, traced variables and,
 * when `positional`, the function's arguments; an unquoted glob or tilde
 * would read the file system or the environment.
 */
export function valueIsTraced(word: string, variables: Set<string>, positional: boolean): boolean {
    let quote: '"' | "'" | null = null;
    for (let index = 0; index < word.length; index += 1) {
        const char = word[index];
        if (quote === "'") {
            if (char === "'") quote = null;
        } else if (char === '\\') {
            index += 1;
        } else if (char === '"' || (char === "'" && quote === null)) {
            quote = quote === char ? null : char;
        } else if (char === '$') {
            const length = expansionLength(word.slice(index + 1), variables, positional);
            if (length < 0) return false;
            index += length;
        } else if (quote === null && ('*?['.includes(char) || (char === '~' && index === 0))) {
            return false;
        }
    }
    return true;
}

/** How many characters after a `$` its traced expansion takes; -1 when it is not traced. */
function expansionLength(rest: string, variables: Set<string>, positional: boolean): number {
    const next = rest[0];
    if (next === '{') {
        const end = rest.indexOf('}');
        return end !== -1 && expansionIsTraced(rest.slice(1, end), variables, positional) ? end : -1;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(rest)?.[0];
    if (name) return variables.has(name) ? name.length : -1;
    if (next !== undefined && '0123456789@*'.includes(next)) return positional ? 1 : -1;
    if (next === '#' || next === '?') return 1;
    // `$$`, `$!` and `$-` read the process; any other `$` is literal.
    return next === '$' || next === '!' || next === '-' ? -1 : 0;
}

function expansionIsTraced(body: string, variables: Set<string>, positional: boolean): boolean {
    const match = EXPANSION_RE.exec(body);
    if (!match) return false;
    const [, length, name, operator, fallback] = match;
    if (length && operator) return false;
    const traced = NAME_RE.test(name) ? variables.has(name) : (name === '#' || name === '?' || positional);
    return traced && (operator === undefined || valueIsTraced(fallback, variables, positional));
}

/** A word with its quotes removed, or null when it expands anything. */
function stripQuotes(word: string): string | null {
    return word.includes('$') ? null : removeQuotes(word);
}

function removeQuotes(word: string): string {
    return word.replace(/\\(.)/gu, '$1').replace(/'([^']*)'|"([^"]*)"/gu, (_, single, double) => single ?? double);
}

/** The characters of a word outside its quotes. */
function unquoted(word: string): string {
    return word.replace(/\\./gu, '').replace(/'[^']*'|"(?:[^"\\]|\\.)*"/gu, '');
}
