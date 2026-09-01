import type {
    GoalProviderOpenContext,
    GoalProviderSessionSnapshot,
    GoalSessionJsonValue,
} from './contract.js';
import { createHash } from 'node:crypto';
import { CODEX_APP_SERVER_0146 } from './codexAppServer0146Schema.js';
import { GoalSessionContractError } from './errors.js';
import { sanitizeNewRecoveryMetadata, sanitizeRecoveryMetadata } from './recoveryMetadata.js';

export const SUPERVISED_CODEX_MODEL = 'gpt-5.6-sol';
export const SUPERVISED_CODEX_PROTOCOL = CODEX_APP_SERVER_0146.protocol;
const CODEX_CONTAINER_CWD = '/workspace';
const MAX_APP_SERVER_LINE_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGES_PER_REQUEST = 512;
const REQUEST_TIMEOUT_MS = 15_000;

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
    try {
        const initialized = await rpc.request(CODEX_APP_SERVER_0146.methods.initialize, {
            clientInfo: { name: 'propr_goal_runtime', title: 'ProPR Goal Runtime', version: '1' },
            capabilities: CODEX_APP_SERVER_0146.initializeCapabilities,
        });
        assertPinnedInitialize(initialized);
        await rpc.notify(CODEX_APP_SERVER_0146.methods.initialized);
        await probeExactModel(rpc);

        const persistedThread = decodePersistedThread(persisted);
        const adoptedThread = persistedThread ?? await findExactOpenKeyThread(rpc, context);
        const thread = adoptedThread
            ? await rpc.request(CODEX_APP_SERVER_0146.methods.threadResume, {
                threadId: adoptedThread.threadId,
                model: SUPERVISED_CODEX_MODEL,
            })
            : await rpc.request(CODEX_APP_SERVER_0146.methods.threadStart, {
                model: SUPERVISED_CODEX_MODEL,
                cwd: CODEX_CONTAINER_CWD,
                approvalPolicy: 'never',
                sandbox: 'workspaceWrite',
                serviceName: durableServiceName(context),
            });
        const identity = decodeThreadResponse(thread, adoptedThread);
        const recoveryMetadata = sanitizeNewRecoveryMetadata({
            version: 2,
            provider: 'codex',
            protocolVersion: SUPERVISED_CODEX_PROTOCOL,
            payload: {
                threadId: identity.threadId,
                sessionId: identity.sessionId,
                initialized: true,
                checkpoint: adoptedThread ? 'response-loss-adopted' : 'thread-started',
                openKey: requiredOpenKey(context),
                repository: context.repository.repository,
                model: SUPERVISED_CODEX_MODEL,
                providerHomeIdentity: context.providerHomeTarget,
            },
            usage: { components: [] },
        }, 'codex');
        return { providerSessionId: identity.threadId, recoveryMetadata, model: SUPERVISED_CODEX_MODEL };
    } catch {
        await context.transport.cancel().catch(() => undefined);
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
        if (this.iterator.return) await this.iterator.return();
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

async function findExactOpenKeyThread(
    rpc: StdioAppServerRpc,
    context: GoalProviderOpenContext,
): Promise<{ threadId: string; sessionId: string } | undefined> {
    const result = await rpc.request(CODEX_APP_SERVER_0146.methods.threadList, {
        limit: 2, cwd: CODEX_CONTAINER_CWD, useStateDbOnly: true,
    });
    const data = result.data;
    if (data === undefined) return undefined;
    if (!Array.isArray(data) || data.length > 2) throw new Error('App Server thread list is malformed');
    const expectedSource = durableServiceName(context);
    const candidates = data.map(candidate => {
        const thread = closedJsonObject(candidate, 'App Server listed thread');
        return {
            threadId: safeId(thread.id),
            sessionId: safeId(thread.sessionId),
            cwd: thread.cwd,
            source: safeId(thread.source),
        };
    });
    const sameWorkspace = candidates.filter(candidate => candidate.cwd === CODEX_CONTAINER_CWD);
    const exact = sameWorkspace.filter(candidate => candidate.source === expectedSource);
    if (exact.length === 0 && sameWorkspace.length > 0) {
        throw new Error('App Server response-loss candidate lacks the exact durable open binding');
    }
    if (exact.length > 1) throw new Error('App Server response-loss adoption is ambiguous');
    return exact[0];
}

function decodePersistedThread(
    persisted: GoalProviderSessionSnapshot | undefined,
): { threadId: string; sessionId: string } | undefined {
    if (!persisted) return undefined;
    const metadata = sanitizeRecoveryMetadata(persisted.recoveryMetadata, 'codex');
    if (!isObject(metadata) || metadata.version !== 2 || !isObject(metadata.payload)) {
        throw new Error('Codex recovery metadata is not a v2 envelope');
    }
    return { threadId: safeId(metadata.payload.threadId), sessionId: safeId(metadata.payload.sessionId) };
}

function decodeThreadResponse(
    result: JsonObject,
    fallback?: { threadId: string; sessionId: string },
): { threadId: string; sessionId: string } {
    if (result.model !== SUPERVISED_CODEX_MODEL || result.cwd !== CODEX_CONTAINER_CWD) {
        throw new Error('App Server ignored or rerouted the exact model or workspace');
    }
    const thread = closedJsonObject(result.thread, 'App Server thread response');
    const threadId = safeId(thread.id);
    const sessionId = safeId(thread.sessionId);
    if (fallback && (fallback.threadId !== threadId || fallback.sessionId !== sessionId)) {
        throw new Error('App Server resumed a different thread identity');
    }
    return { threadId, sessionId };
}

function assertPinnedInitialize(result: JsonObject): void {
    for (const field of ['userAgent', 'codexHome', 'platformFamily', 'platformOs']) {
        if (typeof result[field] !== 'string' || !result[field]) throw new Error('App Server initialize response is malformed');
    }
    if (result.codexHome !== '/home/node/.codex' || result.platformOs !== 'linux') {
        throw new Error('App Server initialize identity is not the supervised container');
    }
}

async function probeExactModel(rpc: StdioAppServerRpc): Promise<void> {
    const result = await rpc.request(CODEX_APP_SERVER_0146.methods.modelList, {
        limit: 100, includeHidden: true,
    });
    if (!Array.isArray(result.data) || result.data.length > 100) throw new Error('App Server model probe is malformed');
    const supported = result.data.some(value => {
        const model = closedJsonObject(value, 'App Server model');
        return model.model === SUPERVISED_CODEX_MODEL || model.id === SUPERVISED_CODEX_MODEL;
    });
    if (!supported) throw new Error('App Server does not support exact gpt-5.6-sol');
}

function durableServiceName(context: GoalProviderOpenContext): string {
    const binding = createHash('sha256').update([
        requiredOpenKey(context), context.repository.repository, SUPERVISED_CODEX_MODEL,
        context.providerHomeTarget,
    ].join('\0')).digest('hex');
    return `propr-open-${binding}`;
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

function isObject(value: unknown): value is JsonObject {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
