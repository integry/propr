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
 *  - its script runs no program and can fail only on those values: it uses
 *    a few builtins, assignments and functions it defines, its tests compare
 *    only those values with string or integer operators (no file test such
 *    as `test -f dist/bundle.js`), and it fails only under such a test (see
 *    `enforcesOnlyResults`); anything else makes it mixed;
 *  - at least one expression reads `needs.<id>.result` of a failed needed job.
 * A step reading the outcome of one of the job's own steps is mixed even when
 * that step passed: GitHub reports a failed `continue-on-error` step as
 * succeeded, so the job's own failure could hide behind the gate.
 */
import { enforcesOnlyResults } from './ciFailureGateScript.js';

// No `working-directory`: a directory the job did not create fails the step on its own.
const STEP_KEYS = new Set(['name', 'id', 'if', 'env', 'run', 'shell', 'timeout-minutes']);
const SHELLS = new Set(['bash', 'sh']);
const EXPRESSION_RE = /\$\{\{([\s\S]*?)\}\}/gu;
const STRING_LITERAL_RE = /'(?:[^']|'')*'/gu;
const IDENTIFIER_RE = /[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_*-]+)*(\s*\()?/gu;
const EXPRESSION_FUNCTIONS = new Set([
    'always', 'success', 'failure', 'cancelled', 'contains', 'startswith', 'endswith', 'format', 'join', 'tojson', 'fromjson',
]);
const EXPRESSION_LITERALS = new Set(['true', 'false', 'null']);
const NEEDS_REFERENCE_RE = /^needs\.([A-Za-z0-9_-]+)\.(result|outputs\.[A-Za-z0-9_-]+)$/u;

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
    const envNames = new Set(Object.keys((step.env ?? {}) as Record<string, unknown>));
    return readsOnlyNeededResults(references, needs, causeIds) && enforcesOnlyResults(values[0], envNames);
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
