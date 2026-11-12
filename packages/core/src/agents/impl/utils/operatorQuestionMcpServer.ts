import {
    GOAL_BLOCKER_MAX_OPTIONS,
    GOAL_BLOCKER_OPTION_LIMIT,
    GOAL_BLOCKER_QUESTION_LIMIT,
} from '@propr/shared';

export { DEFAULT_GOAL_QUESTION_MAX_WAIT_MS, MIN_GOAL_QUESTION_MAX_WAIT_MS } from '@propr/shared';

/**
 * The `ask_operator` tool injected into Claude goal sessions only.
 *
 * It is a dependency-free stdio MCP server running inside the agent container.
 * It needs no network and no credentials: a question is written as a request
 * file into a per-attempt exchange directory under the bind-mounted Claude log
 * directory, and the worker answers it by writing a response file. The worker
 * owns the question's lifecycle (goal blocker, answer, timeout, close); the
 * server only waits, with its own deadline as a fallback if the worker is gone.
 */
export const OPERATOR_QUESTION_SERVER_NAME = 'propr_operator';
export const OPERATOR_QUESTION_TOOL_NAME = 'ask_operator';
export const OPERATOR_QUESTION_MCP_TOOL = `mcp__${OPERATOR_QUESTION_SERVER_NAME}__${OPERATOR_QUESTION_TOOL_NAME}`;
/** Shared with the worker at the same path through the existing `/tmp/claude-logs` bind mount. */
export const OPERATOR_QUESTION_EXCHANGE_ROOT = '/tmp/claude-logs/propr-operator';
export const OPERATOR_QUESTION_MIN_OPTIONS = 2;
/**
 * The server's own deadline trails the worker's, so the worker's timeout (which
 * also closes the blocker) normally decides; the server's covers a lost worker.
 */
export const OPERATOR_QUESTION_SERVER_GRACE_MS = 30_000;
/**
 * Questions stop waiting this long before the attempt's own deadline (at most a
 * tenth of the attempt), so Claude still receives the no-answer result and can
 * continue or stop deliberately before the attempt is killed.
 */
export const OPERATOR_QUESTION_ATTEMPT_RESERVE_MS = 5 * 60 * 1000;
/** A new question is declined when less than this is left before questions close. */
export const OPERATOR_QUESTION_MIN_REMAINING_MS = 60_000;
/** Claude's MCP tool-call limit must outlast both deadlines. */
const CLAUDE_TOOL_TIMEOUT_MARGIN_MS = 5 * 60 * 1000;
/** Node timers cannot wait longer than this. */
const MAX_TIMER_MS = 2_147_483_647;

/** Exchange file layout, shared by the server source below and the worker. */
export const OPERATOR_QUESTION_REQUESTS_DIR = 'requests';
export const OPERATOR_QUESTION_RESPONSES_DIR = 'responses';
/**
 * `<request id>.claim` in the requests directory, created exclusively: the
 * first of the worker (delivering an answer) and the server (handling the
 * client's request cancellation, or giving up at its own deadline) decides
 * whether an operator input is consumed. The server publishes its claims with
 * their content in place, so the worker can tell a timeout from a cancellation.
 */
export const OPERATOR_QUESTION_CLAIM_SUFFIX = '.claim';
export const OPERATOR_QUESTION_CLAIM_ANSWERED = 'answered';
export const OPERATOR_QUESTION_CLAIM_CANCELLED = 'cancelled';
export const OPERATOR_QUESTION_CLAIM_TIMED_OUT = 'timed_out';
/**
 * When the server's deadline loses the claim to the worker's answer, it waits
 * this much longer for that answer to be published before giving up.
 */
export const OPERATOR_QUESTION_ANSWER_PUBLISH_MS = 30_000;

export interface OperatorQuestionRequestFile {
    id: string;
    question: string;
    options: string[];
}

export type OperatorQuestionResponseFile =
    | { status: 'answered'; answer: string }
    | { status: 'no_answer'; message: string }
    | { status: 'closed'; message: string };

export function formatQuestionWait(ms: number): string {
    const hours = ms / 3_600_000;
    if (hours >= 1 && Number.isInteger(hours)) return `${hours} hour${hours === 1 ? '' : 's'}`;
    const minutes = Math.max(1, Math.round(ms / 60_000));
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

export function operatorQuestionToolDescription(maxWaitMs: number): string {
    return [
        'Ask the ProPR operator one question and wait for their answer, which is returned as text.',
        'Use it only for a decision you cannot resolve from the goal, the repository, or a sensible default;',
        'otherwise decide yourself and state the assumption. Ask one question at a time and keep working afterwards.',
        `The call blocks until the operator answers, for at most ${formatQuestionWait(maxWaitMs)}.`,
        'If no answer arrives, continue with a clearly stated assumption, or stop if the decision cannot be made safely.',
        'Never ask for credentials, tokens, passwords, keys or any other secret: answers are stored as ordinary goal input.',
    ].join(' ');
}

/** Guidance sent with the delivery context of a goal session that has the tool. */
export const CLAUDE_OPERATOR_QUESTION_POLICY = [
    `Operator questions: the ${OPERATOR_QUESTION_MCP_TOOL} tool asks the ProPR operator a question and waits for the answer.`,
    'Use it only for a decision you cannot resolve from the goal, the repository or a sensible default; otherwise decide, state the assumption, and continue.',
    'Never ask for credentials or other secrets.',
].join(' ');

/** No-answer reasons when the attempt's remaining time, not the setting, bounds the wait. */
export const OPERATOR_QUESTION_TOO_LATE = 'Too little time is left in this goal attempt to wait for the operator';
export const OPERATOR_QUESTION_ATTEMPT_ENDING = 'No answer from the operator before this goal attempt runs out of time';

export const OPERATOR_QUESTION_MCP_SERVER_SOURCE = String.raw`
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');

const exchange = process.env.PROPR_OPERATOR_EXCHANGE_DIR;
const maxWaitMs = Number(process.env.PROPR_OPERATOR_MAX_WAIT_MS);
const graceMs = Number(process.env.PROPR_OPERATOR_GRACE_MS) || 0;
const description = process.env.PROPR_OPERATOR_TOOL_DESCRIPTION || 'Ask the ProPR operator a question.';
const waitLabel = process.env.PROPR_OPERATOR_WAIT_LABEL || 'the maximum wait';
const closeAt = Number(process.env.PROPR_OPERATOR_CLOSE_AT) || Infinity;
const minRemainingMs = ${OPERATOR_QUESTION_MIN_REMAINING_MS};
const questionLimit = ${GOAL_BLOCKER_QUESTION_LIMIT};
const optionLimit = ${GOAL_BLOCKER_OPTION_LIMIT};
const minOptions = ${OPERATOR_QUESTION_MIN_OPTIONS};
const maxOptions = ${GOAL_BLOCKER_MAX_OPTIONS};
const pollMs = 500;
const tooLate = '${OPERATOR_QUESTION_TOO_LATE}';
const attemptEnding = '${OPERATOR_QUESTION_ATTEMPT_ENDING}';
const answerPublishMs = ${OPERATOR_QUESTION_ANSWER_PUBLISH_MS};
const waits = new Map();

const tools = [{
    name: '${OPERATOR_QUESTION_TOOL_NAME}',
    description,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
        type: 'object',
        properties: {
            question: { type: 'string', minLength: 1, maxLength: questionLimit, description: 'One self-contained question for the operator.' },
            options: {
                type: 'array',
                minItems: minOptions,
                maxItems: maxOptions,
                items: { type: 'string', minLength: 1, maxLength: optionLimit },
                description: 'Optional suggested answers. The operator may still answer freely.',
            },
        },
        required: ['question'],
        additionalProperties: false,
    },
}];

function validate(args) {
    const question = typeof args.question === 'string' ? args.question.trim() : '';
    if (!question) throw new Error('A non-empty question is required.');
    if (question.length > questionLimit) throw new Error('The question must be at most ' + questionLimit + ' characters.');
    if (args.options === undefined || args.options === null) return { question, options: [] };
    if (!Array.isArray(args.options) || args.options.length < minOptions || args.options.length > maxOptions) {
        throw new Error('Options must be a list of ' + minOptions + ' to ' + maxOptions + ' answers.');
    }
    const options = args.options.map(option => typeof option === 'string' ? option.trim() : '');
    if (options.some(option => !option || option.length > optionLimit)) {
        throw new Error('Each option must be a non-empty string of at most ' + optionLimit + ' characters.');
    }
    return { question, options };
}

async function writeAtomic(file, value) {
    const temporary = path.join(path.dirname(file), '.' + path.basename(file) + '.' + process.pid + '.tmp');
    await fsp.writeFile(temporary, JSON.stringify(value), { mode: 0o644 });
    await fsp.rename(temporary, file);
}

function claimPath(id) {
    return path.join(exchange, '${OPERATOR_QUESTION_REQUESTS_DIR}', id + '${OPERATOR_QUESTION_CLAIM_SUFFIX}');
}

/**
 * Claim the question for the server: the client's cancellation or the server's
 * own deadline. True only when this creates the claim: an existing claim is the
 * worker's answer, already being published, or the server's other claim; with
 * no claim recorded the worker may still answer. The claim is linked into place
 * with its content, so the worker never reads an undescribed server claim.
 */
async function claimForServer(id, kind) {
    const target = claimPath(id);
    const temporary = path.join(path.dirname(target), '.' + path.basename(target) + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp');
    try {
        await fsp.writeFile(temporary, kind, { mode: 0o644 });
        await fsp.link(temporary, target);
        return true;
    } catch (error) {
        if (error && error.code === 'EEXIST') return false;
        // Without hard links, create the claim exclusively and describe it afterwards.
        return await claimExclusively(target, kind);
    } finally {
        await fsp.unlink(temporary).catch(() => undefined);
    }
}

async function claimExclusively(target, kind) {
    let handle;
    try {
        handle = await fsp.open(target, 'wx', 0o644);
    } catch (error) {
        if (!error || error.code !== 'EEXIST') process.stderr.write('propr-operator: could not record a ' + kind + ' claim\n');
        return false;
    }
    try {
        await handle.writeFile(kind);
    } catch {
        process.stderr.write('propr-operator: could not describe a ' + kind + ' claim\n');
    } finally {
        await handle.close().catch(() => undefined);
    }
    return true;
}

async function readResponse(id) {
    try {
        return JSON.parse(await fsp.readFile(path.join(exchange, '${OPERATOR_QUESTION_RESPONSES_DIR}', id + '.json'), 'utf8'));
    } catch (error) {
        if (error && error.code === 'ENOENT') return null;
        if (error instanceof SyntaxError) return null;
        throw error;
    }
}

function text(value, isError) {
    return { content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) };
}

function noAnswer(reason) {
    return text((reason || 'No answer from the operator within ' + waitLabel) + '. Continue with a clearly stated assumption, or stop if the decision cannot be made safely.');
}

async function ask(requestId, args) {
    const { question, options } = validate(args);
    if (closeAt - Date.now() < minRemainingMs) return noAnswer(tooLate);
    const id = crypto.randomUUID();
    // Registered before the request is written, so an early cancellation is still published.
    // cancelled is set only by winning the exclusive claim, never by the notification alone.
    const wait = { id, cancelling: false, cancelled: false };
    waits.set(requestId, wait);
    try {
        await writeAtomic(path.join(exchange, '${OPERATOR_QUESTION_REQUESTS_DIR}', id + '.json'), { id, question, options });
        // Never wait past the attempt's question close time, however long the setting allows.
        let deadline = Math.min(Date.now() + maxWaitMs, closeAt) + graceMs;
        let timedOut = false;
        while (!wait.cancelled) {
            const response = await readResponse(id);
            if (response && response.status === 'answered' && typeof response.answer === 'string') {
                return text('The operator answered:\n' + response.answer);
            }
            if (response && response.status === 'no_answer') return noAnswer(typeof response.message === 'string' ? response.message : '');
            if (response && response.status === 'closed') {
                return text('The question was closed without an answer: ' + (response.message || 'the goal stopped waiting') + '.', true);
            }
            if (Date.now() >= deadline) {
                const reason = Date.now() >= closeAt ? attemptEnding : '';
                // The answer claim was not published in time: give up regardless.
                if (timedOut) return noAnswer(reason);
                // Winning the claim stops the worker from consuming an input nothing would read.
                if (await claimForServer(id, '${OPERATOR_QUESTION_CLAIM_TIMED_OUT}')) return noAnswer(reason);
                // Lost to the worker's answer (or this call's cancellation): wait for it to be published.
                timedOut = true;
                deadline = Date.now() + answerPublishMs;
                continue;
            }
            await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
        }
        return text('The question was cancelled.', true);
    } finally {
        waits.delete(requestId);
    }
}

function writeMessage(message) {
    process.stdout.write(JSON.stringify(message) + '\n');
}

async function handleRequest(request) {
    if (request.method === 'initialize') {
        return {
            protocolVersion: request.params && request.params.protocolVersion || '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'propr-operator', version: '1.0.0' },
        };
    }
    if (request.method === 'ping') return {};
    if (request.method === 'tools/list') return { tools };
    if (request.method === 'tools/call') {
        const name = request.params && request.params.name;
        const args = request.params && request.params.arguments || {};
        if (name !== '${OPERATOR_QUESTION_TOOL_NAME}') return text('Unknown tool.', true);
        try {
            return await ask(request.id, args);
        } catch (error) {
            return text(error instanceof Error ? error.message : 'The question could not be asked.', true);
        }
    }
    throw new Error('Method not found.');
}

if (!exchange || !fs.existsSync(exchange) || !Number.isFinite(maxWaitMs) || maxWaitMs <= 0) {
    process.stderr.write('propr-operator: exchange directory or maximum wait is not configured\n');
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', async line => {
    let request;
    try {
        request = JSON.parse(line);
        if (request.method === 'notifications/cancelled') {
            const wait = waits.get(request.params && request.params.requestId);
            if (wait && !wait.cancelling) {
                wait.cancelling = true;
                // Losing the claim to the worker's answer keeps the call waiting for that answer.
                if (await claimForServer(wait.id, '${OPERATOR_QUESTION_CLAIM_CANCELLED}')) wait.cancelled = true;
            }
            return;
        }
        if (request.id === undefined) return;
        const result = await handleRequest(request);
        writeMessage({ jsonrpc: '2.0', id: request.id, result });
    } catch (error) {
        if (request && request.id !== undefined) {
            writeMessage({
                jsonrpc: '2.0',
                id: request.id,
                error: { code: -32603, message: error instanceof Error ? error.message : 'Request failed.' },
            });
        }
    }
});
`;

export interface OperatorQuestionLaunch {
    /** Per-attempt exchange directory; the same path on the worker and inside the container. */
    exchangeDir: string;
    /** How long one question may wait for the operator. */
    maxWaitMs: number;
    /**
     * Epoch milliseconds after which no question waits: the attempt's deadline
     * less the reserve. Absent until the attempt's deadline is known.
     */
    closeAt?: number;
}

/**
 * Bind a launch to the attempt that runs it. `attemptDeadlineAt` must not be
 * later than the moment the attempt is killed; questions close before it with
 * time left for Claude to act on the no-answer result.
 */
export function boundOperatorQuestionLaunch(
    launch: OperatorQuestionLaunch,
    attemptDeadlineAt: number,
    attemptTimeoutMs: number,
    now: number = Date.now(),
): OperatorQuestionLaunch {
    const reserveMs = Math.min(OPERATOR_QUESTION_ATTEMPT_RESERVE_MS, Math.floor(attemptTimeoutMs / 10));
    const closeAt = Math.min(launch.closeAt ?? Infinity, attemptDeadlineAt - reserveMs);
    return { ...launch, closeAt, maxWaitMs: Math.max(1_000, Math.min(launch.maxWaitMs, closeAt - now)) };
}

/** Claude's per-server MCP tool-call limit; it also raises the idle limit for this server. */
export function operatorQuestionToolTimeoutMs(maxWaitMs: number): number {
    return Math.min(maxWaitMs + OPERATOR_QUESTION_SERVER_GRACE_MS + CLAUDE_TOOL_TIMEOUT_MARGIN_MS, MAX_TIMER_MS);
}

export function buildOperatorQuestionMcpConfig(launch: OperatorQuestionLaunch): string {
    if (!launch.exchangeDir.startsWith(`${OPERATOR_QUESTION_EXCHANGE_ROOT}/`)) {
        throw new Error('Operator question exchange must live under the shared Claude log directory');
    }
    return JSON.stringify({
        mcpServers: {
            [OPERATOR_QUESTION_SERVER_NAME]: {
                type: 'stdio',
                command: 'node',
                args: ['-e', OPERATOR_QUESTION_MCP_SERVER_SOURCE],
                env: {
                    PROPR_OPERATOR_EXCHANGE_DIR: launch.exchangeDir,
                    PROPR_OPERATOR_MAX_WAIT_MS: String(launch.maxWaitMs),
                    PROPR_OPERATOR_GRACE_MS: String(OPERATOR_QUESTION_SERVER_GRACE_MS),
                    PROPR_OPERATOR_TOOL_DESCRIPTION: operatorQuestionToolDescription(launch.maxWaitMs),
                    PROPR_OPERATOR_WAIT_LABEL: formatQuestionWait(launch.maxWaitMs),
                    ...(launch.closeAt !== undefined ? { PROPR_OPERATOR_CLOSE_AT: String(launch.closeAt) } : {}),
                },
                timeout: operatorQuestionToolTimeoutMs(launch.maxWaitMs),
            },
        },
    });
}
