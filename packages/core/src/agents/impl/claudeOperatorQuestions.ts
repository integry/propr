import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
    boundGoalBlockerText,
    GOAL_BLOCKER_MAX_OPTIONS,
    GOAL_BLOCKER_OPTION_LIMIT,
    GOAL_BLOCKER_QUESTION_LIMIT,
} from '@propr/shared';
import logger from '../../utils/logger.js';
import { redactSecrets } from '../../utils/github/secretRedaction.js';
import type { GoalBlockerReport, GoalControlInput, GoalExecutionControl } from '../types.js';
import {
    formatQuestionWait,
    OPERATOR_QUESTION_ATTEMPT_ENDING,
    OPERATOR_QUESTION_EXCHANGE_ROOT,
    OPERATOR_QUESTION_MIN_REMAINING_MS,
    OPERATOR_QUESTION_REQUESTS_DIR,
    OPERATOR_QUESTION_RESPONSES_DIR,
    OPERATOR_QUESTION_TOO_LATE,
    OPERATOR_QUESTION_TOOL_NAME,
    type OperatorQuestionLaunch,
    type OperatorQuestionResponseFile,
} from './utils/operatorQuestionMcpServer.js';

export const CLAUDE_OPERATOR_QUESTION_SOURCE = `claude_mcp:${OPERATOR_QUESTION_TOOL_NAME}`;
const REQUEST_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;

/** What the protocol needs from the question channel; tests substitute their own. */
export interface ClaudeOperatorQuestionChannel {
    /**
     * Report questions the session asked since the last call and time out
     * overdue ones. With no turn (the context turn) a new question is declined.
     */
    sync(turnId: string | null): Promise<void>;
    /** Deliver an operator input as the answer to the one waiting question it follows. */
    answer(input: GoalControlInput, turnId: string): Promise<boolean>;
    /** Stop waiting on every open question and close its blocker. */
    closeOpen(resolution: string, message: string): Promise<void>;
}

interface OpenQuestion {
    id: string;
    requestKey: string;
    /** Highest input sequence recorded before the blocker was opened. */
    inputBoundary: number;
    /** When the question stops waiting: its own maximum wait, or the attempt's close time if sooner. */
    expiresAt: number;
    /** The attempt's close time, not the setting, ends the wait. */
    endsWithAttempt: boolean;
}

/** Create a private per-attempt exchange directory the container user can write requests into. */
export async function createOperatorQuestionExchange(
    maxWaitMs: number,
    root: string = OPERATOR_QUESTION_EXCHANGE_ROOT,
): Promise<OperatorQuestionLaunch> {
    await fs.mkdir(root, { recursive: true });
    // The worker and the container's `node` user may differ, and the shared log
    // directory is world-readable: unlistable directories with random names.
    await fs.chmod(root, 0o711).catch(() => undefined);
    const exchangeDir = path.join(root, randomUUID());
    await fs.mkdir(exchangeDir, { mode: 0o711 });
    await fs.chmod(exchangeDir, 0o711);
    const requests = path.join(exchangeDir, OPERATOR_QUESTION_REQUESTS_DIR);
    const responses = path.join(exchangeDir, OPERATOR_QUESTION_RESPONSES_DIR);
    await fs.mkdir(requests);
    await fs.chmod(requests, 0o733);
    await fs.mkdir(responses);
    await fs.chmod(responses, 0o711);
    return { exchangeDir, maxWaitMs };
}

export async function removeOperatorQuestionExchange(launch: OperatorQuestionLaunch): Promise<void> {
    await fs.rm(launch.exchangeDir, { recursive: true, force: true }).catch(error => {
        logger.warn({ exchangeDir: launch.exchangeDir, error: (error as Error).message }, 'Could not remove operator question exchange');
    });
}

function boundedText(value: unknown, limit: number): string {
    return typeof value === 'string' && value.trim()
        ? boundGoalBlockerText(redactSecrets(value.trim()), limit)
        : '';
}

function parseRequest(raw: string, id: string): { question: string; options: string[] } | null {
    let record: Record<string, unknown>;
    try { record = JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
    if (!record || typeof record !== 'object' || record.id !== id) return null;
    const question = boundedText(record.question, GOAL_BLOCKER_QUESTION_LIMIT);
    if (!question) return null;
    const options = Array.isArray(record.options)
        ? record.options.slice(0, GOAL_BLOCKER_MAX_OPTIONS).map(option => boundedText(option, GOAL_BLOCKER_OPTION_LIMIT)).filter(Boolean)
        : [];
    return { question, options };
}

/** Without a recorded boundary or input order, the input cannot be shown to follow the question. */
function answersAfter(question: OpenQuestion, input: GoalControlInput): boolean {
    return input.sequence !== undefined && input.sequence > question.inputBoundary;
}

/**
 * `ask_operator` questions of one Claude goal attempt. Each is a goal blocker
 * of category `question`, fenced to the attempt by the control, answered by the
 * next operator input submitted after it opened, and closed when it is
 * answered, times out, or its turn or attempt ends.
 */
export class ClaudeOperatorQuestions implements ClaudeOperatorQuestionChannel {
    private readonly open = new Map<string, OpenQuestion>();
    /** Requests already handled; a request file is never reported twice. */
    private readonly seen = new Set<string>();

    constructor(
        private readonly launch: OperatorQuestionLaunch,
        private readonly control: Pick<GoalExecutionControl, 'reportBlocker' | 'resolveBlocker' | 'markInputDelivered'>,
        private readonly sessionId: string,
        private readonly now: () => number = Date.now,
    ) {}

    get waiting(): number { return this.open.size; }

    private requestKey(id: string): string {
        return `claude:${this.sessionId}:${OPERATOR_QUESTION_TOOL_NAME}:${id}`;
    }

    private async respond(id: string, response: OperatorQuestionResponseFile): Promise<void> {
        const directory = path.join(this.launch.exchangeDir, OPERATOR_QUESTION_RESPONSES_DIR);
        const file = path.join(directory, `${id}.json`);
        const temporary = path.join(directory, `.${id}.${randomUUID()}.tmp`);
        await fs.writeFile(temporary, JSON.stringify(response), { mode: 0o644 });
        await fs.chmod(temporary, 0o644);
        await fs.rename(temporary, file);
    }

    /** A question that is not waited on gets a best-effort reply; the server's own deadline covers a lost one. */
    private async decline(id: string, message: string): Promise<void> {
        await this.respond(id, { status: 'closed', message }).catch(error => {
            logger.warn({ id, error: (error as Error).message }, 'Could not close an operator question');
        });
    }

    private async newRequests(): Promise<Array<{ id: string; question: string; options: string[] }>> {
        const directory = path.join(this.launch.exchangeDir, OPERATOR_QUESTION_REQUESTS_DIR);
        let names: string[];
        try { names = await fs.readdir(directory); } catch { return []; }
        const requests: Array<{ id: string; question: string; options: string[] }> = [];
        for (const name of names.sort()) {
            const id = REQUEST_FILE.exec(name)?.[1];
            if (!id || this.seen.has(id)) continue;
            this.seen.add(id);
            const parsed = parseRequest(await fs.readFile(path.join(directory, name), 'utf8').catch(() => ''), id);
            if (!parsed) {
                await this.decline(id, 'ProPR could not read the question');
                continue;
            }
            requests.push({ id, ...parsed });
        }
        return requests;
    }

    private report(id: string, question: string, options: string[], turnId: string): GoalBlockerReport {
        return {
            requestKey: this.requestKey(id),
            category: 'question',
            source: CLAUDE_OPERATOR_QUESTION_SOURCE,
            summary: question,
            questions: [{ id, header: null, question, options, confidential: false }],
            responseActions: ['send_input', 'pause', 'cancel'],
            turnId,
        };
    }

    async sync(turnId: string | null): Promise<void> {
        for (const request of await this.newRequests()) {
            if (!turnId) {
                await this.decline(request.id, 'questions are accepted once the goal is running');
                continue;
            }
            const closeAt = this.launch.closeAt ?? Infinity;
            if (closeAt - this.now() < OPERATOR_QUESTION_MIN_REMAINING_MS) {
                // No blocker: the attempt ends before the operator could usefully answer.
                await this.respond(request.id, { status: 'no_answer', message: OPERATOR_QUESTION_TOO_LATE }).catch(error => {
                    logger.warn({ id: request.id, error: (error as Error).message }, 'Could not decline a late operator question');
                });
                continue;
            }
            // The boundary is stored by the write that makes the blocker visible.
            const boundary = await this.control.reportBlocker?.(this.report(request.id, request.question, request.options, turnId));
            if (typeof boundary !== 'number') {
                await this.decline(request.id, 'ProPR could not record the question for this goal attempt');
                continue;
            }
            const ownExpiry = this.now() + this.launch.maxWaitMs;
            this.open.set(request.id, {
                id: request.id, requestKey: this.requestKey(request.id), inputBoundary: boundary,
                expiresAt: Math.min(ownExpiry, closeAt), endsWithAttempt: closeAt < ownExpiry,
            });
        }
        for (const question of [...this.open.values()]) {
            if (this.now() < question.expiresAt) continue;
            this.open.delete(question.id);
            await this.respond(question.id, {
                status: 'no_answer',
                message: question.endsWithAttempt
                    ? OPERATOR_QUESTION_ATTEMPT_ENDING
                    : `No answer from the operator within ${formatQuestionWait(this.launch.maxWaitMs)}`,
            });
            await this.control.resolveBlocker?.(question.requestKey, 'question_timed_out');
        }
    }

    /**
     * A goal input names no question, so while several wait it answers none,
     * and an input queued before the question opened is an unrelated correction.
     */
    async answer(input: GoalControlInput, turnId: string): Promise<boolean> {
        const waiting = [...this.open.values()];
        const question = waiting.length === 1 && answersAfter(waiting[0], input) ? waiting[0] : undefined;
        if (!question) return false;
        this.open.delete(question.id);
        await this.respond(question.id, { status: 'answered', answer: input.message });
        await this.control.markInputDelivered(input.id, turnId);
        await this.control.resolveBlocker?.(question.requestKey, 'answered');
        return true;
    }

    async closeOpen(resolution: string, message: string): Promise<void> {
        for (const question of [...this.open.values()]) {
            this.open.delete(question.id);
            await this.decline(question.id, message);
            await this.control.resolveBlocker?.(question.requestKey, resolution);
        }
    }
}
