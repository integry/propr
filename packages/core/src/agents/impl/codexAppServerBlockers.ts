import {
    boundGoalBlockerText,
    GOAL_BLOCKER_HEADER_LIMIT,
    GOAL_BLOCKER_MAX_OPTIONS,
    GOAL_BLOCKER_MAX_QUESTIONS,
    GOAL_BLOCKER_OPTION_LIMIT,
    GOAL_BLOCKER_QUESTION_LIMIT,
} from '@propr/shared';
import { redactSecrets } from '../../utils/github/secretRedaction.js';
import type { AgentTaskOptions, GoalBlockerReport, GoalControlInput } from '../types.js';
import type { AppServerConnection } from './codexAppServerConnection.js';

/**
 * Codex App Server server-initiated requests that wait for a person.
 *
 * Only these structured requests become goal blockers. Every other server
 * request (dynamic tool calls, auth refresh, attestation) and every
 * notification, agent message or silence stays out of the attention surfaces.
 */
export const CODEX_USER_INPUT_REQUEST = 'item/tool/requestUserInput';
export const CODEX_APPROVAL_REQUESTS = [
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
    'execCommandApproval',
    'applyPatchApproval',
] as const;
export const CODEX_ELICITATION_REQUEST = 'mcpServer/elicitation/request';

const SUMMARY_DETAIL_LIMIT = 400;

export interface CodexServerRequestBlocker {
    report: GoalBlockerReport;
    /** Question ids a goal input answers; empty when the request cannot be answered through ProPR. */
    answerQuestionIds: string[];
}

type Params = Record<string, unknown>;

function text(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value : null;
}

/** Provider text is bounded and secret-redacted before it can reach any projection. */
function safe(value: unknown, limit: number): string {
    const raw = text(value);
    return raw ? boundGoalBlockerText(redactSecrets(raw), limit) : '';
}

function requestKey(parts: Array<unknown>): string {
    return ['codex', ...parts.map(part => (typeof part === 'string' || typeof part === 'number') ? String(part) : '-')]
        .join(':').slice(0, 255);
}

function withReason(headline: string, reason: unknown): string {
    const detail = safe(reason, SUMMARY_DETAIL_LIMIT);
    return detail ? `${headline} — ${detail}` : headline;
}

function commandText(command: unknown): string {
    if (Array.isArray(command)) return command.filter(part => typeof part === 'string').join(' ');
    return typeof command === 'string' ? command : '';
}

function userInputBlocker(params: Params): CodexServerRequestBlocker | null {
    // A non-blocking request lets the provider carry on without an answer, so
    // nothing is waiting on the operator.
    if (params.isBlocking === false) return null;
    const requested = Array.isArray(params.questions) ? params.questions : [];
    const questions = requested
        .slice(0, GOAL_BLOCKER_MAX_QUESTIONS)
        .flatMap(item => {
            const record = item && typeof item === 'object' ? item as Params : {};
            const question = safe(record.question, GOAL_BLOCKER_QUESTION_LIMIT);
            const id = text(record.id);
            if (!question || !id) return [];
            const options = Array.isArray(record.options)
                ? record.options.slice(0, GOAL_BLOCKER_MAX_OPTIONS)
                    .map(option => safe((option as Params | null)?.label, GOAL_BLOCKER_OPTION_LIMIT)).filter(Boolean)
                : [];
            return [{
                id,
                header: safe(record.header, GOAL_BLOCKER_HEADER_LIMIT) || null,
                question,
                options,
                confidential: record.isSecret === true,
            }];
        });
    if (!questions.length) return null;
    // A secret answer would be persisted as goal input; hand those off instead.
    // One goal input answers exactly one question, so a request asking several
    // is handed off rather than given the same answer to each.
    const answerable = requested.length === 1 && questions.length === 1 && !questions[0].confidential;
    const summary = questions.length === 1
        ? questions[0].question
        : `${questions.length} questions: ${questions[0].question}`;
    return {
        report: {
            requestKey: requestKey([params.threadId, params.turnId, params.itemId, 'user-input']),
            category: 'question',
            source: `codex_app_server:${CODEX_USER_INPUT_REQUEST}`,
            summary,
            // The id is bounded for display only; the reply keeps the provider's own id.
            questions: questions.map(question => ({ ...question, id: question.id.slice(0, GOAL_BLOCKER_HEADER_LIMIT) })),
            responseActions: answerable ? ['send_input', 'pause', 'cancel'] : ['pause', 'cancel'],
            ...(text(params.turnId) ? { turnId: String(params.turnId) } : {}),
        },
        answerQuestionIds: answerable ? questions.map(question => question.id) : [],
    };
}

function approvalSummary(method: string, params: Params): string {
    if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
        const verb = params.kind === 'writeStdin' ? 'Approve input to a running command' : 'Approve command';
        const command = safe(commandText(params.command), SUMMARY_DETAIL_LIMIT);
        return withReason(command ? `${verb}: ${command}` : verb, params.reason);
    }
    if (method === 'item/permissions/requestApproval') return withReason('Approve additional permissions', params.reason);
    const root = safe(params.grantRoot, SUMMARY_DETAIL_LIMIT);
    return withReason(root ? `Approve file changes under ${root}` : 'Approve file changes', params.reason);
}

function approvalBlocker(method: string, params: Params): CodexServerRequestBlocker {
    const legacy = method === 'execCommandApproval' || method === 'applyPatchApproval';
    const key = legacy
        ? requestKey([params.conversationId, params.callId, params.approvalId ?? method])
        : requestKey([params.threadId, params.turnId, params.itemId, params.approvalId ?? method]);
    return {
        report: {
            requestKey: key,
            category: 'approval',
            source: `codex_app_server:${method}`,
            summary: approvalSummary(method, params),
            // ProPR never answers an approval on the operator's behalf.
            responseActions: ['pause', 'cancel'],
            ...(text(params.turnId) ? { turnId: String(params.turnId) } : {}),
        },
        answerQuestionIds: [],
    };
}

function elicitationBlocker(id: unknown, params: Params): CodexServerRequestBlocker | null {
    const message = safe(params.message, GOAL_BLOCKER_QUESTION_LIMIT);
    if (!message) return null;
    const server = safe(params.serverName, GOAL_BLOCKER_HEADER_LIMIT);
    return {
        report: {
            requestKey: requestKey([params.threadId, params.turnId, 'elicitation', server, params.elicitationId ?? id]),
            category: 'question',
            source: `codex_app_server:${CODEX_ELICITATION_REQUEST}`,
            // The URL of a URL-mode elicitation can carry credentials; only the message is shown.
            summary: server ? `${server}: ${message}` : message,
            questions: [{ id: 'elicitation', header: server || null, question: message, options: [], confidential: false }],
            responseActions: ['pause', 'cancel'],
            ...(text(params.turnId) ? { turnId: String(params.turnId) } : {}),
        },
        answerQuestionIds: [],
    };
}

/** The blocker a Codex server request represents, or null when it does not wait for a person. */
export function codexServerRequestBlocker(message: { id?: unknown; method?: unknown; params?: unknown }): CodexServerRequestBlocker | null {
    if (typeof message.method !== 'string' || message.id === undefined || message.id === null) return null;
    const params = message.params && typeof message.params === 'object' ? message.params as Params : {};
    if (message.method === CODEX_USER_INPUT_REQUEST) return userInputBlocker(params);
    if ((CODEX_APPROVAL_REQUESTS as readonly string[]).includes(message.method)) return approvalBlocker(message.method, params);
    if (message.method === CODEX_ELICITATION_REQUEST) return elicitationBlocker(message.id, params);
    return null;
}

/** The `ToolRequestUserInputResponse` carrying one operator input as the answer to a single-question request. */
export function codexUserInputResponse(questionIds: string[], answer: string): Record<string, unknown> {
    if (questionIds.length !== 1) throw new Error('A goal input answers exactly one Codex question');
    return { answers: { [questionIds[0]]: { answers: [answer] } } };
}

/** Without a recorded boundary or input order, the input cannot be shown to follow the question. */
function answersAfter(request: OpenProviderRequest, input: GoalControlInput): boolean {
    return request.inputBoundary !== undefined && input.sequence !== undefined && input.sequence > request.inputBoundary;
}

interface OpenProviderRequest {
    id: number | string;
    requestKey: string;
    answerQuestionIds: string[];
    answered: boolean;
    /**
     * Highest input sequence submitted before the question was reported. Only
     * later inputs can be its answer; earlier ones stay ordinary corrections.
     */
    inputBoundary?: number;
}

/**
 * Structured Codex requests for a person, tracked for one turn. A request is
 * reported once it arrives and resolved only on authoritative evidence: the
 * server's `serverRequest/resolved`, or the end of the turn that raised it.
 * Answering a question with a goal input does not resolve it by itself.
 */
export class CodexProviderRequests {
    private readonly open = new Map<number | string, OpenProviderRequest>();

    constructor(
        private readonly connection: AppServerConnection,
        private readonly control: NonNullable<AgentTaskOptions['goalControl']>,
    ) {}

    async sync(): Promise<void> {
        await this.persist(this.absorb());
        // Read after the report is stored: every input up to this point was
        // submitted before the operator could see the question.
        for (const request of this.open.values()) {
            if (!request.answerQuestionIds.length || request.inputBoundary !== undefined) continue;
            const boundary = await this.control.latestInputSequence?.();
            if (boundary !== undefined) request.inputBoundary = boundary;
        }
    }

    /**
     * Apply every request and resolution the connection has already received
     * to the local map, without awaiting, and return the durable writes owed.
     */
    private absorb(): { reports: GoalBlockerReport[]; resolved: string[] } {
        const reports: GoalBlockerReport[] = [];
        const resolved: string[] = [];
        for (const message of this.connection.takeServerRequests()) {
            const blocker = codexServerRequestBlocker(message);
            if (!blocker || message.id === undefined) continue;
            if (!this.open.has(message.id)) {
                this.open.set(message.id, {
                    id: message.id,
                    requestKey: blocker.report.requestKey,
                    answerQuestionIds: blocker.answerQuestionIds,
                    answered: false,
                });
            }
            reports.push(blocker.report);
        }
        for (const id of this.connection.takeResolvedServerRequests()) {
            const request = this.open.get(id);
            if (!request) continue;
            this.open.delete(id);
            resolved.push(request.requestKey);
        }
        return { reports, resolved };
    }

    private async persist(work: { reports: GoalBlockerReport[]; resolved: string[] }): Promise<void> {
        for (const report of work.reports) await this.control.reportBlocker?.(report);
        for (const requestKey of work.resolved) await this.control.resolveBlocker?.(requestKey, 'provider_resolved');
    }

    /**
     * Deliver an operator input as the reply to the unanswered question, if exactly one is waiting
     * and the input was submitted after that question was reported. A goal input names no question,
     * so while several wait it answers none of them, and an input queued before the question is an
     * unrelated correction; both are delivered as ordinary corrections instead.
     * Resolutions received while the caller awaited are applied first, with no await before the
     * response, so an input is never spent on a question the server already reported resolved.
     */
    async answer(input: GoalControlInput, turnId: string): Promise<boolean> {
        const work = this.absorb();
        const waiting = [...this.open.values()].filter(request => !request.answered && request.answerQuestionIds.length);
        const question = waiting.length === 1 && answersAfter(waiting[0], input) ? waiting[0] : undefined;
        if (question) {
            this.connection.respond(question.id, codexUserInputResponse(question.answerQuestionIds, input.message));
            question.answered = true;
        }
        await this.persist(work);
        if (!question) return false;
        await this.control.markInputDelivered(input.id, turnId);
        return true;
    }

    /** A thread runs one turn at a time, so a finished turn leaves no request waiting. */
    async closeTurn(): Promise<void> {
        for (const [id, request] of this.open) {
            this.open.delete(id);
            await this.control.resolveBlocker?.(request.requestKey, 'turn_ended');
        }
    }
}
