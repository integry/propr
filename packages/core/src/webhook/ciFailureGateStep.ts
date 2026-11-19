/**
 * Recognizes a workflow step that only enforces the results of the jobs its
 * job needs, such as `Enforce shard and docs results`, from its definition.
 *
 * Reading `needs.<id>.result` is not enough: the same step could also run the
 * job's own tests, or enforce the outcome of one of the job's own steps. A
 * step is a gate step only with positive evidence that it does nothing else:
 *  - it is a plain `run` step (no `uses`, `with` or other keys), in bash or sh;
 *  - every expression it holds (in `run`, `env` and `if`) reads only the
 *    results and outputs of the jobs the job needs, the `github` context, or
 *    status functions; the step's own job's state (`steps.*`, `env`, `inputs`,
 *    …) makes it mixed;
 *  - its script runs no program: every command is a shell builtin from a short
 *    list (`echo`, `printf`, `test`, `[`, `exit`, `return`, …), a variable
 *    assignment, or a function the script defines; command substitution,
 *    `eval`, `source`, `case` and anything else unrecognized make it mixed;
 *  - at least one expression reads `needs.<id>.result` of a failed needed job.
 * A step reading the outcome of one of the job's own steps is mixed even when
 * that step passed: GitHub reports a failed `continue-on-error` step as
 * succeeded, so the job's own failure could hide behind the gate.
 */

const STEP_KEYS = new Set(['name', 'id', 'if', 'env', 'run', 'shell', 'timeout-minutes', 'working-directory']);
const SHELLS = new Set(['bash', 'sh']);
const EXPRESSION_RE = /\$\{\{([\s\S]*?)\}\}/gu;
const STRING_LITERAL_RE = /'(?:[^']|'')*'/gu;
const IDENTIFIER_RE = /[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_*-]+)*(\s*\()?/gu;
const EXPRESSION_FUNCTIONS = new Set([
    'always', 'success', 'failure', 'cancelled', 'contains', 'startswith', 'endswith', 'format', 'join', 'tojson', 'fromjson',
]);
const EXPRESSION_LITERALS = new Set(['true', 'false', 'null']);
const NEEDS_REFERENCE_RE = /^needs\.([A-Za-z0-9_-]+)\.(result|outputs\.[A-Za-z0-9_-]+)$/u;
const SHELL_BUILTINS = new Set(['echo', 'printf', 'test', '[', '[[', 'exit', 'return', 'true', 'false', ':', 'local', 'set', 'shopt']);
const SHELL_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'while', 'until', 'do', 'done', '!', '{', '}']);
const FUNCTION_DEFINITION_RE = /^[ \t]*(?:function[ \t]+)?([A-Za-z_][A-Za-z0-9_-]*)[ \t]*\([ \t]*\)/gmu;
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/u;

/** Whether `step` only enforces the results of `needs` jobs, and reads the result of at least one of `causeIds`. */
export function isGateStep(step: Record<string, unknown>, needs: string[], causeIds: Set<string>): boolean {
    const values = stepValues(step);
    if (!values) return false;
    const references: string[] = [];
    for (const value of values) {
        const read = expressionReferences(value);
        if (!read) return false;
        references.push(...read);
    }
    return readsOnlyNeededResults(references, needs, causeIds) && runsNoProgram(values[0]);
}

/** The step's script first, then its `env` values and `if`; null when it is not a plain shell `run` step. */
function stepValues(step: Record<string, unknown>): string[] | null {
    if (!Object.keys(step).every(key => STEP_KEYS.has(key)) || typeof step.run !== 'string') return null;
    if (step.shell !== undefined && !(typeof step.shell === 'string' && SHELLS.has(step.shell.trim()))) return null;
    const env = step.env === undefined ? {} : step.env;
    if (typeof env !== 'object' || env === null || Array.isArray(env)) return null;
    const values: unknown[] = [step.run, ...Object.values(env)];
    // An `if` may omit the `${{ }}` around its expression.
    if (step.if !== undefined) values.push(typeof step.if === 'string' && !step.if.includes('${{') ? `\${{ ${step.if} }}` : step.if);
    if (!values.every(value => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) return null;
    return values.map(String);
}

/** Every reference is a needed job's result or output, or the `github` context; one is a failed needed job's result. */
function readsOnlyNeededResults(references: string[], needs: string[], causeIds: Set<string>): boolean {
    const needed = new Set(needs.map(need => need.toLowerCase()));
    let readsCauseResult = false;
    for (const reference of references) {
        const match = NEEDS_REFERENCE_RE.exec(reference);
        if (!match) {
            if (!reference.startsWith('github.')) return false;
            continue;
        }
        const id = match[1].toLowerCase();
        if (!needed.has(id)) return false;
        if (match[2] === 'result' && causeIds.has(id)) readsCauseResult = true;
    }
    return readsCauseResult;
}

/** The context references of every expression in `text`; null when an expression calls an unknown function. */
function expressionReferences(text: string): string[] | null {
    const references: string[] = [];
    for (const [, body] of text.matchAll(EXPRESSION_RE)) {
        for (const match of body.replace(STRING_LITERAL_RE, "''").matchAll(IDENTIFIER_RE)) {
            const word = match[0].replace(/\s*\($/u, '');
            if (match[1] !== undefined) {
                if (!EXPRESSION_FUNCTIONS.has(word.toLowerCase())) return null;
            } else if (!EXPRESSION_LITERALS.has(word.toLowerCase())) {
                references.push(word);
            }
        }
    }
    return references;
}

/**
 * Whether a shell script only uses builtins, assignments and its own
 * functions. Expressions are replaced first: they were checked on their own.
 */
export function runsNoProgram(script: string): boolean {
    const text = script.replace(EXPRESSION_RE, 'x');
    const commands = splitCommands(text);
    if (!commands) return false;
    const functions = new Set([...text.matchAll(FUNCTION_DEFINITION_RE)].map(match => match[1]));
    return commands.every(words => commandIsBuiltin(words, functions));
}

function commandIsBuiltin(words: string[], functions: Set<string>): boolean {
    let index = 0;
    while (index < words.length) {
        const word = words[index];
        if (SHELL_KEYWORDS.has(word) || ASSIGNMENT_RE.test(word)) {
            index += 1;
        } else if (word === 'function') {
            index += 2;
        } else {
            break;
        }
    }
    if (index >= words.length) return true;
    const command = words[index];
    // A function definition's name is followed by the `()` this splitter cut off.
    return SHELL_BUILTINS.has(command) || functions.has(command);
}

/**
 * The script's simple commands, as unquoted words with quotes kept; null for
 * anything this reader does not follow (command or process substitution,
 * arithmetic, here-documents, unterminated quotes). Any other construct
 * (`case`, `for`, `eval`, `source`, …) leaves a word in command position that
 * is not a builtin, so the script is not a gate.
 */
function splitCommands(text: string): string[][] | null {
    const lexer = new ShellLexer(text);
    return lexer.run() ? lexer.commands : null;
}

/** A small reader of shell words; any construct it does not follow stops it. */
class ShellLexer {
    readonly commands: string[][] = [];
    private words: string[] = [];
    private word = '';
    private quote: '"' | "'" | null = null;
    private index = 0;

    constructor(private readonly text: string) {}

    run(): boolean {
        for (; this.index < this.text.length; this.index += 1) {
            if (!this.step(this.text[this.index], this.text[this.index + 1])) return false;
        }
        this.endCommand();
        return this.quote === null;
    }

    private step(char: string, next: string | undefined): boolean {
        if (this.quote === "'") {
            this.word += char;
            if (char === "'") this.quote = null;
            return true;
        }
        if (char === '`' || (char === '$' && next === '(')) return false;
        if (char === '\\') return this.escape(next);
        if (char === '$' && next === '{') return this.expansion();
        if (this.quote === '"') {
            this.word += char;
            if (char === '"') this.quote = null;
            return true;
        }
        return this.unquoted(char, next);
    }

    private escape(next: string | undefined): boolean {
        // A line continuation joins the lines; any other escape stays in the word.
        if (next !== '\n') this.word += `\\${next ?? ''}`;
        this.index += 1;
        return true;
    }

    private expansion(): boolean {
        const end = this.text.indexOf('}', this.index);
        const expansion = this.text.slice(this.index, end + 1);
        if (end === -1 || expansion.includes('$(') || expansion.includes('`')) return false;
        this.word += expansion;
        this.index = end;
        return true;
    }

    private unquoted(char: string, next: string | undefined): boolean {
        if ((char === '<' || char === '>') && next === '(') return false;
        if (char === '<' && next === '<') return false;
        if (char === "'" || char === '"') {
            this.quote = char;
            this.word += char;
        } else if (char === '#' && this.word === '') {
            while (this.index + 1 < this.text.length && this.text[this.index + 1] !== '\n') this.index += 1;
        } else if (char === '&' && /[<>]$/u.test(this.word)) {
            this.word += char;
        } else if ('\n;&|(){}'.includes(char)) {
            this.endWord();
            if (char === '{' || char === '}') this.words.push(char);
            this.endCommand();
        } else if (char === ' ' || char === '\t' || char === '\r') {
            this.endWord();
        } else {
            this.word += char;
        }
        return true;
    }

    private endWord(): void {
        if (this.word) this.words.push(this.word);
        this.word = '';
    }

    private endCommand(): void {
        this.endWord();
        if (this.words.length > 0) this.commands.push(this.words);
        this.words = [];
    }
}
