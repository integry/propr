/**
 * Tells a CI failure the code cannot fix (a runner or infrastructure problem)
 * apart from a code failure, from the evidence the CI-failure comment is built
 * from: the check's annotations and output, and the names of its failed steps.
 *
 * The decision is deliberately conservative. A failure is only infrastructure
 * when nothing in the evidence looks like a test, compile or lint failure and
 *  - the runner itself went away (shutdown signal, lost communication) while
 *    running the only step that failed, or with no step failed: a step that
 *    failed before another step started failed on its own, so the runner going
 *    away later (say in an `always()` cleanup) does not excuse it, or
 *  - every failed step is a setup/install step and the evidence shows a
 *    network, mirror or registry error.
 * Unknown steps, a failure in a test or build step, or any doubt keep the
 * failure a code failure, which starts the code follow-up as before.
 *
 * Pure: no I/O, so each rule is unit-testable.
 */
import type { CiFailureAnnotation } from './ciFailureFollowup.js';

export interface CiInfrastructureEvidence {
    kind: 'check_run' | 'status';
    /** The check's conclusion (`failure`, `timed_out`, …). */
    state: string;
    /** Annotation and output text of the failure; any order. */
    texts: Array<string | null | undefined>;
    /** The check's annotations; absent when they could not be read, which keeps the failure a code failure. */
    annotations?: CiFailureAnnotation[];
    /** Names of the job's failed steps; null or absent when they could not be read. Derived from `steps` when absent. */
    failedSteps?: string[] | null;
    /**
     * The job's steps in run order; null or absent when they could not be
     * read, which keeps a runner loss a code failure, since nothing then
     * shows which step the runner loss interrupted.
     */
    steps?: CiJobStep[] | null;
}

/** One step of a GitHub Actions job, as the jobs API reports it. */
export interface CiJobStep {
    name: string;
    /** `queued`, `in_progress`, `completed`, …; absent when not reported. */
    status?: string | null;
    /** `success`, `failure`, `skipped`, …; null while the step has not finished. */
    conclusion?: string | null;
}

export type CiInfrastructureCause = 'runner_lost' | 'network';

export interface CiInfrastructureVerdict {
    infrastructure: boolean;
    cause?: CiInfrastructureCause;
    /** The failed setup step, when the cause is a network/mirror/registry error. */
    step?: string;
}

/** Conclusions an infrastructure problem produces; a startup failure or required action is a configuration matter. */
const INFRASTRUCTURE_CONCLUSIONS = new Set(['failure', 'timed_out']);

/** Evidence of a test, compile or lint failure: any of these keeps the failure a code failure. */
const CODE_FAILURE_PATTERNS: readonly RegExp[] = [
    /\berror TS\d{3,5}\b/,
    /\bAssertionError\b/,
    /\bassert(?:ion)? failed\b/i,
    /\b\d+ (?:tests? )?(?:failed|failing|failures?)\b/i,
    /\btests? failed\b/i,
    /^\s*not ok \d+/m,
    /(?:^|\s)FAIL\s+\S/m,
    /\b\d+ problems? \(\d+ errors?/,
    /\beslint\b/i,
    /\blint(?:ing)? (?:error|failed)/i,
    /--max-warnings/,
    /\b(?:SyntaxError|TypeError|ReferenceError|RangeError)\b/,
    /\bcompil(?:e|ation) (?:error|failed)\b/i,
    /\berror\[E\d+\]/,
    /\.\w+:\d+(?::\d+)?: error\b/,
    /\bexpected\b.*\b(?:to|but)\b/i,
    /[✖✗]/u,
];

/** The runner went away under the job: whatever step was running, the code did not fail. */
const RUNNER_LOST_PATTERNS: readonly RegExp[] = [
    /\bThe runner has received a shutdown signal\b/i,
    /\blost communication with the server\b/i,
    /\bThe hosted runner encountered an error while running your job\b/i,
    /\bThe job was not acquired by Runner\b/i,
];

/** Network, mirror and registry errors; infrastructure only when a setup/install step failed with them. */
const NETWORK_PATTERNS: readonly RegExp[] = [
    /\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|ERR_SOCKET_TIMEOUT|ESOCKETTIMEDOUT)\b/,
    /\bsocket hang up\b/i,
    /\bTemporary failure (?:in name )?resolution\b/i,
    /\bCould not (?:connect|resolve)\b/i,
    /\bConnection (?:timed out|reset by peer|refused)\b/i,
    /\bFailed to fetch https?:\/\//i,
    /\bUnable to fetch some archives\b/i,
    /\bHash Sum mismatch\b/i,
    /\binstall(?:ation)? timed out\b/i,
    /\bnetwork (?:error|timeout|is unreachable)\b/i,
    /\b(?:TLS handshake timeout|i\/o timeout)\b/i,
    /\b50[0-4] (?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out)\b/i,
    /\bnpm (?:ERR!|error) code E(?:50[0-4]|AI_AGAIN|CONNRESET|TIMEDOUT|SOCKETTIMEDOUT)\b/i,
    /\breceived unexpected HTTP status: 5\d\d\b/i,
    /\btoomanyrequests\b/i,
];

/**
 * Steps that run the code (tests, builds, lint, type checks): a step named
 * like this is never a setup step, even when it also installs something
 * ("Install dependencies and run tests") or names a browser ("Run Playwright
 * tests"), so a network error in it stays a code failure.
 */
const EXECUTION_STEP_PATTERN = /\b(?:tests?|testing|specs?|e2e|smoke|acceptance|integration|unit|coverage|build(?:ing|s)?|compil(?:e|ing|ation)|bundle|lint(?:ing)?|eslint|prettier|format|type-?check(?:ing)?|tsc|check|verify|validate|vitest|jest|mocha|pytest|cargo|benchmarks?)\b/i;

/**
 * Steps that only prepare the job: checkout, toolchains, dependency and
 * browser installs, caches, images. Each alternative names a preparation
 * operation; a bare tool or browser name does not.
 */
const SETUP_STEP_PATTERN = /\b(?:set ?up|setup|install(?:ing|s)?|npm ci|(?:yarn|pnpm) install|apt(?:-get)? (?:update|install)|pip install|download(?:ing)?|(?:restore |save )?cache|checkout|docker (?:pull|login)|pull image|initialize containers)\b/i;

/**
 * Joiners between two operations ("Install dependencies and run migrations",
 * "Setup && seed database", "Install Chromium / launch app"): a step that
 * names more than one operation is never a setup step. A leading "Run" is
 * GitHub's prefix for an unnamed command step, not a joiner, so `run` only
 * counts after another word. A `/` counts when spaced or between two bare
 * words, not inside a path such as `./scripts/ci-install.sh`.
 */
const COMPOUND_STEP_PATTERNS: readonly RegExp[] = [
    /\b(?:and|then|plus)\b/i,
    /\S\s+(?:run|runs|running)\s+\S/i,
    /&&|;|\|/,
    /\w\s*[+,]\s*\w/,
    /\s\/|\/\s/,
    /(?<![\w./@-])[a-z]+\/[a-z]+(?![\w./@-])/i,
];

/** GitHub's generated name for an action step: `Run <owner>/<action>[/<path>]@<ref>`, or its `Post Run` cleanup. */
const ACTION_STEP_PATTERN = /^(?:Post )?Run [\w.-]+\/([\w.-]+)(?:\/[\w.-]+)*@[\w./-]+$/;

/** Actions that only prepare the job (checkout, setup-*, cache, login, download-artifact). */
const SETUP_ACTION_PATTERN = /^(?:checkout|setup-[\w.-]+|cache|login(?:-action)?|download-artifact)$/i;
/** Step conclusions that count as the step having failed. */
export const FAILED_STEP_CONCLUSIONS: ReadonlySet<string> = new Set(['failure', 'timed_out']);
/** Step statuses of a step that never started. */
const NOT_STARTED_STEP_STATUSES = new Set(['queued', 'pending', 'waiting', 'requested']);

/** Names of the failed steps, in run order. */
export function failedStepNames(steps: readonly CiJobStep[]): string[] {
    return steps.filter(step => typeof step.conclusion === 'string' && FAILED_STEP_CONCLUSIONS.has(step.conclusion)).map(step => step.name);
}

/** Whether a step ran (or started to): skipped and not-yet-started steps did not; unknown state counts as started. */
function stepStarted(step: CiJobStep): boolean {
    if (step.conclusion === 'skipped') return false;
    if (step.conclusion == null && typeof step.status === 'string' && NOT_STARTED_STEP_STATUSES.has(step.status)) return false;
    return true;
}

/**
 * Whether the runner loss can account for every failed step: none failed, or
 * exactly one did and no step started after it, so it is the step the runner
 * loss interrupted. A step that failed before another started (a test step
 * followed by an `always()` cleanup the runner was lost in) failed on its
 * own; unread steps cannot show either.
 */
function runnerLossExplainsFailedSteps(steps: readonly CiJobStep[] | null | undefined): boolean {
    if (!steps) return false;
    const failed = steps.flatMap((step, index) => (typeof step.conclusion === 'string' && FAILED_STEP_CONCLUSIONS.has(step.conclusion) ? [index] : []));
    if (failed.length === 0) return true;
    if (failed.length > 1) return false;
    return !steps.slice(failed[0] + 1).some(stepStarted);
}

/** Runner notices and annotations the runner attaches to the workflow file say nothing about the code. */
function pointsAtSource(annotation: CiFailureAnnotation): boolean {
    const path = annotation.path?.trim();
    return !!path && path !== '.github' && !path.startsWith('.github/');
}

function annotationText(annotation: CiFailureAnnotation): string[] {
    return [annotation.title, annotation.message, annotation.raw_details].filter((text): text is string => typeof text === 'string');
}

/** Whether any text shows a sign of an infrastructure problem; a cheap pre-check before reading the job's steps. */
export function hasInfrastructureSignature(texts: ReadonlyArray<string | null | undefined>): boolean {
    const joined = texts.filter(Boolean).join('\n');
    return [...RUNNER_LOST_PATTERNS, ...NETWORK_PATTERNS].some(pattern => pattern.test(joined));
}

/**
 * A step that only prepares the job: one setup operation and nothing else.
 * Anything that also runs tests, builds or lint, or names a second operation,
 * is not. A generated action step is setup only when the action is one.
 */
export function isSetupStep(name: string): boolean {
    const trimmed = name.trim();
    const action = ACTION_STEP_PATTERN.exec(trimmed);
    if (action) return SETUP_ACTION_PATTERN.test(action[1]);
    if (EXECUTION_STEP_PATTERN.test(trimmed)) return false;
    if (COMPOUND_STEP_PATTERNS.some(pattern => pattern.test(trimmed))) return false;
    return SETUP_STEP_PATTERN.test(trimmed);
}

/** Classifies a failure as infrastructure-only, or not (the default whenever the evidence is not conclusive). */
export function classifyCiInfrastructureFailure(evidence: CiInfrastructureEvidence): CiInfrastructureVerdict {
    const notInfrastructure: CiInfrastructureVerdict = { infrastructure: false };
    if (evidence.kind !== 'check_run' || !INFRASTRUCTURE_CONCLUSIONS.has(evidence.state.toLowerCase())) return notInfrastructure;
    // Unread annotations cannot rule out one pointing at a source file: doubt keeps it a code failure.
    const annotations = evidence.annotations;
    if (!annotations) return notInfrastructure;
    if (annotations.some(pointsAtSource)) return notInfrastructure;
    const text = [...evidence.texts, ...annotations.flatMap(annotationText)].filter(Boolean).join('\n');
    if (!text || CODE_FAILURE_PATTERNS.some(pattern => pattern.test(text))) return notInfrastructure;

    if (RUNNER_LOST_PATTERNS.some(pattern => pattern.test(text))) {
        return runnerLossExplainsFailedSteps(evidence.steps) ? { infrastructure: true, cause: 'runner_lost' } : notInfrastructure;
    }

    const steps = evidence.failedSteps ?? (evidence.steps ? failedStepNames(evidence.steps) : null);
    if (!steps || steps.length === 0 || !steps.every(isSetupStep)) return notInfrastructure;
    if (!NETWORK_PATTERNS.some(pattern => pattern.test(text))) return notInfrastructure;
    return { infrastructure: true, cause: 'network', step: steps[0] };
}
