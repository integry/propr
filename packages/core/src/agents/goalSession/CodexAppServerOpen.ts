import type {
    GoalProviderOpenContext,
    GoalProviderSessionSnapshot,
    GoalSessionJsonValue,
} from './contract.js';
import { GoalSessionContractError } from './errors.js';
import { sanitizeRecoveryMetadata } from './recoveryMetadata.js';

export const SUPERVISED_CODEX_MODEL = 'gpt-5.6-sol';
const MAX_APP_SERVER_LINE_BYTES = 1024 * 1024;
const MAX_MESSAGES_PER_REQUEST = 512;

type JsonObject = Record<string, GoalSessionJsonValue>;

/**
 * Performs the non-experimental stdio App Server eager-open lifecycle.  It
 * initializes exactly once, adopts/resumes a uniquely isolated existing thread
 * after response loss, or starts a thread without inventing a turn.
 */
export async function openSupervisedCodexAppServer(
    context: GoalProviderOpenContext,
    persisted?: GoalProviderSessionSnapshot,
): Promise<GoalProviderSessionSnapshot> {
    validateContext(context);
    const rpc = new StdioAppServerRpc(context);
    try {
        await rpc.request('initialize', {
            clientInfo: { name: 'propr_goal_runtime', title: 'ProPR Goal Runtime', version: '1' },
        });
        await rpc.notify('initialized', {});
        const persistedThread = decodePersistedThread(persisted);
        const adoptedThread = persistedThread ?? await findUniqueIsolatedThread(rpc, context);
        const thread = adoptedThread
            ? await rpc.request('thread/resume', { threadId: adoptedThread.threadId, model: SUPERVISED_CODEX_MODEL })
            : await rpc.request('thread/start', {
                model: SUPERVISED_CODEX_MODEL,
                cwd: context.repository.worktreePath,
                approvalPolicy: 'never',
                sandbox: 'workspaceWrite',
                serviceName: `propr_goal_${context.executionId}`,
            });
        const identity = decodeThreadResponse(thread, adoptedThread);
        const recoveryMetadata = sanitizeRecoveryMetadata({
            version: 2,
            provider: 'codex',
            protocolVersion: 'app-server-0.146.0',
            payload: {
                threadId: identity.threadId,
                sessionId: identity.sessionId,
                initialized: true,
                checkpoint: adoptedThread ? 'response-loss-adopted' : 'thread-started',
            },
            usage: { components: [] },
        }, 'codex');
        return { providerSessionId: identity.threadId, recoveryMetadata, model: SUPERVISED_CODEX_MODEL };
    } catch {
        await context.transport.cancel().catch(() => undefined);
        throw new GoalSessionContractError('Codex App Server open failed safely', 'PROVIDER_OPERATION_FAILED');
    }
}

class StdioAppServerRpc {
    private readonly iterator: AsyncIterator<string>;
    private requestSequence = 0;

    constructor(private readonly context: GoalProviderOpenContext) {
        this.iterator = context.transport.output[Symbol.asyncIterator]();
    }

    async notify(method: string, params: JsonObject): Promise<void> {
        await this.write({ method, params });
    }

    async request(method: string, params: JsonObject): Promise<JsonObject> {
        const id = `${this.context.executionId}-${this.context.attemptId}-${this.requestSequence}`;
        this.requestSequence += 1;
        await this.write({ method, id, params });
        for (let count = 0; count < MAX_MESSAGES_PER_REQUEST; count += 1) {
            const next = await this.iterator.next();
            if (next.done) throw new Error('App Server output ended before its response');
            const message = parseMessage(next.value);
            if (message.id !== id) continue;
            if (message.error !== undefined) throw new Error('App Server rejected a request');
            if (!isObject(message.result)) throw new Error('App Server response is malformed');
            return message.result;
        }
        throw new Error('App Server response exceeded its message bound');
    }

    private async write(message: JsonObject): Promise<void> {
        const line = `${JSON.stringify(message)}\n`;
        if (Buffer.byteLength(line) > MAX_APP_SERVER_LINE_BYTES) throw new Error('App Server request is oversized');
        await this.context.transport.write(line);
    }
}

async function findUniqueIsolatedThread(
    rpc: StdioAppServerRpc,
    context: GoalProviderOpenContext,
): Promise<{ threadId: string; sessionId?: string } | undefined> {
    const result = await rpc.request('thread/list', {
        limit: 2,
        cwd: context.repository.worktreePath,
        useStateDbOnly: true,
    });
    const data = result.data;
    if (data === undefined) return undefined;
    if (!Array.isArray(data) || data.length > 2) throw new Error('App Server thread list is malformed');
    const candidates = data.map(candidate => {
        if (!isObject(candidate)) throw new Error('App Server thread is malformed');
        return {
            threadId: safeId(candidate.id),
            sessionId: candidate.sessionId === undefined ? undefined : safeId(candidate.sessionId),
            cwd: candidate.cwd,
            preview: candidate.preview,
        };
    }).filter(candidate => candidate.cwd === context.repository.worktreePath
        && (candidate.preview === '' || candidate.preview === undefined));
    if (candidates.length > 1) throw new Error('App Server response-loss adoption is ambiguous');
    return candidates[0];
}

function decodePersistedThread(
    persisted: GoalProviderSessionSnapshot | undefined,
): { threadId: string; sessionId?: string } | undefined {
    if (!persisted) return undefined;
    const metadata = sanitizeRecoveryMetadata(persisted.recoveryMetadata, 'codex');
    if (!isObject(metadata) || metadata.version !== 2 || !isObject(metadata.payload)) {
        throw new Error('Codex recovery metadata is not a v2 envelope');
    }
    return {
        threadId: safeId(metadata.payload.threadId),
        sessionId: metadata.payload.sessionId === undefined ? undefined : safeId(metadata.payload.sessionId),
    };
}

function decodeThreadResponse(
    result: JsonObject,
    fallback?: { threadId: string; sessionId?: string },
): { threadId: string; sessionId: string } {
    if (!isObject(result.thread)) throw new Error('App Server thread response is malformed');
    const threadId = safeId(result.thread.id);
    if (fallback && fallback.threadId !== threadId) throw new Error('App Server resumed a different thread');
    const sessionId = result.thread.sessionId === undefined
        ? fallback?.sessionId ?? threadId
        : safeId(result.thread.sessionId);
    return { threadId, sessionId };
}

function parseMessage(line: string): JsonObject {
    if (typeof line !== 'string' || Buffer.byteLength(line) > MAX_APP_SERVER_LINE_BYTES) throw new Error('App Server line is invalid');
    let value: unknown;
    try { value = JSON.parse(line); }
    catch { throw new Error('App Server emitted invalid JSON'); }
    if (!isObject(value)) throw new Error('App Server message is not an object');
    return value;
}

function validateContext(context: GoalProviderOpenContext): void {
    if (context.requestedModel !== SUPERVISED_CODEX_MODEL) {
        throw new GoalSessionContractError('Supervised Codex open requires exact gpt-5.6-sol', 'MODEL_ACK_MISMATCH');
    }
    if (!context.repository.worktreePath.startsWith('/') || context.providerHomeTarget !== '/home/node/.codex') {
        throw new GoalSessionContractError('Codex open context is not canonical', 'UNSAFE_PROVIDER_VALUE');
    }
}

function safeId(value: GoalSessionJsonValue | undefined): string {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) throw new Error('App Server identity is invalid');
    return value;
}

function isObject(value: unknown): value is JsonObject {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
