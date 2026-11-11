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
/** Claude's MCP tool-call limit must outlast both deadlines. */
const CLAUDE_TOOL_TIMEOUT_MARGIN_MS = 5 * 60 * 1000;
/** Node timers cannot wait longer than this. */
const MAX_TIMER_MS = 2_147_483_647;

/** Exchange file layout, shared by the server source below and the worker. */
export const OPERATOR_QUESTION_REQUESTS_DIR = 'requests';
export const OPERATOR_QUESTION_RESPONSES_DIR = 'responses';

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
const questionLimit = ${GOAL_BLOCKER_QUESTION_LIMIT};
const optionLimit = ${GOAL_BLOCKER_OPTION_LIMIT};
const minOptions = ${OPERATOR_QUESTION_MIN_OPTIONS};
const maxOptions = ${GOAL_BLOCKER_MAX_OPTIONS};
const pollMs = 500;
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

function noAnswer() {
    return text('No answer from the operator within ' + waitLabel + '. Continue with a clearly stated assumption, or stop if the decision cannot be made safely.');
}

async function ask(requestId, args) {
    const { question, options } = validate(args);
    const id = crypto.randomUUID();
    await writeAtomic(path.join(exchange, '${OPERATOR_QUESTION_REQUESTS_DIR}', id + '.json'), { id, question, options });
    const deadline = Date.now() + maxWaitMs + graceMs;
    const wait = { cancelled: false };
    waits.set(requestId, wait);
    try {
        while (!wait.cancelled) {
            const response = await readResponse(id);
            if (response && response.status === 'answered' && typeof response.answer === 'string') {
                return text('The operator answered:\n' + response.answer);
            }
            if (response && response.status === 'no_answer') return noAnswer();
            if (response && response.status === 'closed') {
                return text('The question was closed without an answer: ' + (response.message || 'the goal stopped waiting') + '.', true);
            }
            if (Date.now() >= deadline) return noAnswer();
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
            if (wait) wait.cancelled = true;
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
                },
                timeout: operatorQuestionToolTimeoutMs(launch.maxWaitMs),
            },
        },
    });
}
