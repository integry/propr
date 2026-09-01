import type {
    GoalProviderOpenContext,
    GoalProviderSessionSnapshot,
    GoalSessionJsonValue,
} from './contract.js';
import {
    CODEX_APP_SERVER_METHODS_0146, CODEX_APP_SERVER_PROTOCOL_0146, CODEX_CLI_VERSION_0146,
    type CodexThreadResponse0146, type CodexThreadResumeParams0146, type CodexThreadStartParams0146,
} from './codexAppServer0146Bindings.generated.js';
import { GoalSessionContractError } from './errors.js';
import { sanitizeNewRecoveryMetadata, sanitizeRecoveryMetadata } from './recoveryMetadata.js';
import { assertExactThreadFields, assertExactThreadResponseFields } from './codexAppServer0146Validation.js';

export const SUPERVISED_CODEX_MODEL = 'gpt-5.6-sol';
export const SUPERVISED_CODEX_PROTOCOL = CODEX_APP_SERVER_PROTOCOL_0146;
const CODEX_CONTAINER_CWD = '/workspace';
const MAX_APP_SERVER_LINE_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGES_PER_REQUEST = 512;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_MODEL_PAGES = 16;
const MAX_MODELS = 1_600;

type JsonObject = Record<string, GoalSessionJsonValue>;

/**
 * Pinned Codex 0.146 stdio App Server lifecycle.  The transport must already be
 * constructed under the supervisor's durable open claim.  No turn identity is
 * accepted or invented by this control-scoped operation.
 */
export async function openSupervisedCodexAppServer(
    context: GoalProviderOpenContext,
    persisted?: GoalProviderSessionSnapshot,
): Promise<GoalProviderSessionSnapshot> {
    validateContext(context);
    const rpc = new StdioAppServerRpc(context);
    let newThreadRequestStarted = false;
    try {
        const initialized = await rpc.request(CODEX_APP_SERVER_METHODS_0146.initialize, {
            clientInfo: {
                name: 'propr_goal_runtime', title: 'ProPR Goal Runtime', version: CODEX_CLI_VERSION_0146,
            },
            capabilities: { experimentalApi: false, requestAttestation: false },
        });
        assertPinnedInitialize(initialized);
        await rpc.notify(CODEX_APP_SERVER_METHODS_0146.initialized);
        await probeExactModel(rpc);

        const persistedThread = decodePersistedThread(persisted, context);
        let thread: JsonObject;
        if (persistedThread) {
            const params: CodexThreadResumeParams0146 = {
                threadId: persistedThread.threadId,
                model: SUPERVISED_CODEX_MODEL,
                cwd: CODEX_CONTAINER_CWD,
                approvalPolicy: 'never',
                sandbox: 'workspace-write',
                excludeTurns: true,
            };
            thread = await rpc.request(CODEX_APP_SERVER_METHODS_0146.threadResume, params as unknown as JsonObject);
        } else {
            const params: CodexThreadStartParams0146 = {
                model: SUPERVISED_CODEX_MODEL,
                cwd: CODEX_CONTAINER_CWD,
                approvalPolicy: 'never',
                sandbox: 'workspace-write',
            };
            newThreadRequestStarted = true;
            thread = await rpc.request(CODEX_APP_SERVER_METHODS_0146.threadStart, params as JsonObject);
        }
        const identity = decodeThreadResponse(thread, persistedThread);
        const recoveryMetadata = sanitizeNewRecoveryMetadata({
            version: 2,
            provider: 'codex',
            protocolVersion: SUPERVISED_CODEX_PROTOCOL,
            payload: {
                threadId: identity.threadId,
                sessionId: identity.sessionId,
                initialized: true,
                checkpoint: persistedThread ? 'thread-resumed' : 'thread-started',
                openKey: requiredOpenKey(context),
                repository: context.repository.repository,
                model: SUPERVISED_CODEX_MODEL,
                providerHomeIdentity: context.providerHomeTarget,
                cliVersion: CODEX_CLI_VERSION_0146,
            },
            usage: { components: [] },
        }, 'codex');
        return { providerSessionId: identity.threadId, recoveryMetadata, model: SUPERVISED_CODEX_MODEL };
    } catch (error) {
        if (newThreadRequestStarted && !persisted) throw new GoalSessionContractError(
            'Codex thread creation is in doubt; exact identifiers were not persisted', 'PROVIDER_OPEN_IN_DOUBT',
        );
        if (error instanceof GoalSessionContractError) throw error;
        throw new GoalSessionContractError('Codex App Server open failed safely', 'PROVIDER_OPERATION_FAILED');
    } finally {
        await rpc.close().catch(() => undefined);
    }
}

class StdioAppServerRpc {
    private readonly iterator: AsyncIterator<string>;
    private readonly lines: BoundedLineReader;
    private requestSequence = 0;
    private consumedBytes = 0;

    constructor(private readonly context: GoalProviderOpenContext) {
        this.iterator = context.transport.output[Symbol.asyncIterator]();
        this.lines = new BoundedLineReader(this.iterator);
    }

    async close(): Promise<void> {
        try { this.context.transport.closeInput(); }
        catch { /* Cancellation below remains mandatory. */ }
        await this.context.transport.cancel();
        try {
            const returned = this.iterator.return?.();
            if (returned) void returned.catch(() => undefined);
        } catch { /* The owned process is already cancelled. */ }
    }

    async notify(method: string): Promise<void> {
        await this.write({ method });
    }

    async request(method: string, params: JsonObject): Promise<JsonObject> {
        const id = `${this.context.executionId}-${this.context.attemptId}-${this.requestSequence}`;
        this.requestSequence += 1;
        return withTimeout(this.requestUntilResponse(method, id, params), this.context.transport);
    }

    private async requestUntilResponse(method: string, id: string, params: JsonObject): Promise<JsonObject> {
        await this.write({ method, id, params });
        for (let count = 0; count < MAX_MESSAGES_PER_REQUEST; count += 1) {
            const line = await this.lines.nextLine();
            this.consumedBytes += Buffer.byteLength(line);
            if (this.consumedBytes > MAX_REQUEST_BYTES) throw new Error('App Server aggregate response is oversized');
            const message = parseMessage(line);
            if (message.id !== id) continue;
            if (message.error !== undefined) throw new Error('App Server rejected a request');
            return closedJsonObject(message.result, 'App Server response result');
        }
        throw new Error('App Server response exceeded its message bound');
    }

    private async write(message: JsonObject): Promise<void> {
        const line = `${JSON.stringify(message)}\n`;
        if (Buffer.byteLength(line) > MAX_APP_SERVER_LINE_BYTES) throw new Error('App Server request is oversized');
        await this.context.transport.write(line);
    }
}

class BoundedLineReader {
    private readonly decoder = new TextDecoder('utf-8', { fatal: true });
    private buffered = '';

    constructor(private readonly iterator: AsyncIterator<string>) {}

    async nextLine(): Promise<string> {
        for (;;) {
            const newline = this.buffered.indexOf('\n');
            if (newline >= 0) {
                const line = this.buffered.slice(0, newline).replace(/\r$/, '');
                this.buffered = this.buffered.slice(newline + 1);
                if (Buffer.byteLength(line) > MAX_APP_SERVER_LINE_BYTES) throw new Error('App Server line is oversized');
                if (!line) continue;
                return line;
            }
            const next = await this.iterator.next();
            if (next.done) {
                const tail = this.buffered;
                this.buffered = '';
                if (tail) return tail;
                throw new Error('App Server output ended before its response');
            }
            if (typeof next.value !== 'string') throw new Error('App Server emitted a non-string protocol chunk');
            const bytes = Buffer.from(next.value);
            this.buffered += this.decoder.decode(bytes, { stream: true });
            if (Buffer.byteLength(this.buffered) > MAX_APP_SERVER_LINE_BYTES) throw new Error('App Server line is oversized');
            // The production channel is newline-framed.  Retain compatibility
            // with an isolated transport that emits exactly one complete JSON
            // value per iterator item without the delimiter.
            if (isCompleteJsonObject(this.buffered)) {
                const line = this.buffered;
                this.buffered = '';
                return line;
            }
        }
    }
}

function isCompleteJsonObject(value: string): boolean {
    if (!value.startsWith('{') || !value.endsWith('}')) return false;
    try { return isObject(JSON.parse(value)); }
    catch { return false; }
}

async function withTimeout<T>(operation: Promise<T>, transport: GoalProviderOpenContext['transport']): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('App Server request timed out')), REQUEST_TIMEOUT_MS);
    });
    try {
        return await Promise.race([operation, timeout]);
    } catch (error) {
        await transport.cancel().catch(() => undefined);
        throw error;
    } finally {
        if (timer) clearTimeout(timer);
        void operation.catch(() => undefined);
    }
}

function decodePersistedThread(
    persisted: GoalProviderSessionSnapshot | undefined,
    context: GoalProviderOpenContext,
): { threadId: string; sessionId: string } | undefined {
    if (!persisted) return undefined;
    const metadata = sanitizeRecoveryMetadata(persisted.recoveryMetadata, 'codex');
    if (!isObject(metadata) || metadata.version !== 2 || !isObject(metadata.payload)) {
        throw new Error('Codex recovery metadata is not a v2 envelope');
    }
    const payload = metadata.payload;
    const threadId = safeId(payload.threadId);
    const sessionId = safeId(payload.sessionId);
    if (persisted.providerSessionId !== threadId || persisted.model !== SUPERVISED_CODEX_MODEL
        || payload.openKey !== requiredOpenKey(context)
        || payload.repository !== context.repository.repository
        || payload.model !== SUPERVISED_CODEX_MODEL
        || payload.providerHomeIdentity !== context.providerHomeTarget
        || payload.cliVersion !== CODEX_CLI_VERSION_0146
        || metadata.protocolVersion !== SUPERVISED_CODEX_PROTOCOL) {
        throw new Error('Codex persisted resume identity does not match the exact open claim');
    }
    return { threadId, sessionId };
}

function decodeThreadResponse(
    result: JsonObject,
    fallback?: { threadId: string; sessionId: string },
): { threadId: string; sessionId: string } {
    const response = exactJsonObject(result, [
        'thread', 'model', 'modelProvider', 'serviceTier', 'cwd', 'runtimeWorkspaceRoots',
        'instructionSources', 'approvalPolicy', 'approvalsReviewer', 'sandbox',
        'activePermissionProfile', 'reasoningEffort', 'multiAgentMode',
        ...(fallback ? ['initialTurnsPage', 'turnsBackwardsCursor', 'itemsBackwardsCursor'] : []),
    ], 'App Server thread response') as unknown as CodexThreadResponse0146;
    assertExactThreadResponseFields(response);
    if (response.model !== SUPERVISED_CODEX_MODEL || response.cwd !== CODEX_CONTAINER_CWD) {
        throw new Error('App Server ignored or rerouted the exact model or workspace');
    }
    const thread = decodeExactThread(response.thread);
    const threadId = safeId(thread.id);
    const sessionId = safeId(thread.sessionId);
    if (fallback && (fallback.threadId !== threadId || fallback.sessionId !== sessionId)) {
        throw new Error('App Server resumed a different thread identity');
    }
    return { threadId, sessionId };
}

function decodeExactThread(value: unknown): JsonObject {
    const thread = exactJsonObject(value, [
        'id', 'extra', 'sessionId', 'forkedFromId', 'parentThreadId', 'preview', 'ephemeral', 'isPinned',
        'historyMode', 'modelProvider', 'createdAt', 'updatedAt', 'recencyAt', 'status', 'path', 'cwd',
        'cliVersion', 'source', 'canAcceptDirectInput', 'threadSource', 'agentNickname', 'agentRole',
        'gitInfo', 'name', 'turns',
    ], 'App Server thread');
    assertExactThreadFields(thread as unknown as import('./codexAppServer0146Bindings.generated.js').CodexThread0146);
    if (thread.cwd !== CODEX_CONTAINER_CWD || thread.cliVersion !== CODEX_CLI_VERSION_0146) {
        throw new Error('App Server thread identity is not from exact Codex 0.146 App Server');
    }
    return thread;
}

function assertPinnedInitialize(result: JsonObject): void {
    for (const field of ['userAgent', 'codexHome', 'platformFamily', 'platformOs']) {
        if (typeof result[field] !== 'string' || !result[field]) throw new Error('App Server initialize response is malformed');
    }
    if (result.codexHome !== '/home/node/.codex' || result.platformOs !== 'linux') {
        throw new Error('App Server initialize identity is not the supervised container');
    }
    if (typeof result.userAgent !== 'string'
        || !result.userAgent.startsWith(`propr_goal_runtime/${CODEX_CLI_VERSION_0146} (`)) {
        throw new Error('App Server CLI version is not exactly pinned');
    }
}

async function probeExactModel(rpc: StdioAppServerRpc): Promise<void> {
    let cursor: string | null = null;
    let supported = false;
    let total = 0;
    const seen = new Set<string>();
    for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
        const raw = await rpc.request(CODEX_APP_SERVER_METHODS_0146.modelList, {
            limit: 100, includeHidden: true, cursor,
        });
        const result = exactJsonObject(raw, ['data', 'nextCursor'], 'App Server model/list response');
        if (!Array.isArray(result.data) || result.data.length > 100
            || (result.nextCursor !== null && typeof result.nextCursor !== 'string')) {
            throw new Error('App Server model probe is malformed');
        }
        total += result.data.length;
        if (total > MAX_MODELS) throw new Error('App Server model probe exceeded its aggregate bound');
        supported ||= result.data.some(value => {
            const model = closedJsonObject(value, 'App Server model');
            return model.model === SUPERVISED_CODEX_MODEL || model.id === SUPERVISED_CODEX_MODEL;
        });
        if (result.nextCursor === null) break;
        cursor = result.nextCursor;
        if (seen.has(cursor)) throw new Error('App Server model pagination cursor repeated');
        seen.add(cursor);
        if (page === MAX_MODEL_PAGES - 1) throw new Error('App Server model pagination exceeded its page bound');
    }
    if (!supported) throw new Error('App Server does not support exact gpt-5.6-sol');
}

function requiredOpenKey(context: GoalProviderOpenContext): string {
    return safeId(context.deterministicOpenKey);
}

function parseMessage(line: string): JsonObject {
    if (typeof line !== 'string' || Buffer.byteLength(line) > MAX_APP_SERVER_LINE_BYTES) throw new Error('App Server line is invalid');
    let value: unknown;
    try { value = JSON.parse(line); }
    catch { throw new Error('App Server emitted invalid JSON'); }
    return closedJsonObject(value, 'App Server message');
}

function validateContext(context: GoalProviderOpenContext): void {
    if (context.requestedModel !== SUPERVISED_CODEX_MODEL) {
        throw new GoalSessionContractError('Supervised Codex open requires exact gpt-5.6-sol', 'MODEL_ACK_MISMATCH');
    }
    if (!context.repository.worktreePath.startsWith('/') || context.providerHomeTarget !== '/home/node/.codex') {
        throw new GoalSessionContractError('Codex open context is not canonical', 'UNSAFE_PROVIDER_VALUE');
    }
    requiredOpenKey(context);
}

function safeId(value: GoalSessionJsonValue | undefined): string {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) throw new Error('App Server identity is invalid');
    return value;
}

function closedJsonObject(value: unknown, name: string): JsonObject {
    if (!isObject(value)) throw new Error(`${name} is malformed`);
    // JSON.parse results are data-only, but callers can also pass hostile
    // persisted/test objects. Rebuild recursively through serialization after
    // checking for accessors and non-data prototypes.
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length
        || Object.values(descriptors).some(descriptor => !descriptor.enumerable || !('value' in descriptor))) {
        throw new Error(`${name} contains an accessor`);
    }
    return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function exactJsonObject(value: unknown, fields: readonly string[], name: string): JsonObject {
    const result = closedJsonObject(value, name);
    const actual = Object.keys(result);
    if (actual.length !== fields.length || fields.some(field => !(field in result))) {
        throw new Error(`${name} does not match the generated Codex 0.146 schema`);
    }
    return result;
}

function isObject(value: unknown): value is JsonObject {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
