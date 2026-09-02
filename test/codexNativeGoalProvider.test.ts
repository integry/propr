import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
    CodexAppServerClient,
    type CodexAppServerTransport,
} from '../packages/core/src/codex/appServer/CodexAppServerClient.js';
import {
    CodexNativeGoalProvider,
    classifyCodexGoalNotification,
} from '../packages/core/src/codex/appServer/CodexNativeGoalProvider.js';

type WireMessage = { method?: string; id?: string | number; params?: Record<string, unknown>; result?: unknown };

class ScriptedTransport implements CodexAppServerTransport {
    readonly sent: WireMessage[] = [];
    private readonly listeners = new Set<(message: unknown) => void>();
    private threadId = 'codex-thread-2007';
    activeTurnId = 'turn-native-goal';
    objective = 'Make the goal durable';

    async send(value: unknown): Promise<void> {
        const message = value as WireMessage;
        this.sent.push(structuredClone(message));
        if (message.id === undefined || !message.method) return;
        queueMicrotask(() => this.answer(message));
    }

    onMessage(listener: (message: unknown) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    async close(): Promise<void> { this.listeners.clear(); }

    notify(method: string, params: Record<string, unknown>): void {
        for (const listener of this.listeners) listener({ method, params });
    }

    private answer(request: WireMessage): void {
        const params = request.params ?? {};
        let result: unknown = {};
        if (request.method === 'initialize') {
            result = { userAgent: 'codex-test', codexHome: '/state', platformFamily: 'unix', platformOs: 'linux' };
        } else if (request.method === 'thread/start' || request.method === 'thread/resume') {
            if (request.method === 'thread/resume') this.threadId = String(params.threadId);
            result = { thread: { id: this.threadId }, model: 'gpt-effective', reasoningEffort: 'high' };
        } else if (request.method === 'thread/goal/set') {
            if (typeof params.objective === 'string') this.objective = params.objective;
            const status = params.status ?? 'active';
            result = { goal: this.goal(String(status)) };
            if (status === 'paused' && this.activeTurnId) {
                const turnId = this.activeTurnId;
                this.activeTurnId = '';
                queueMicrotask(() => this.notify('turn/completed', {
                    threadId: this.threadId, turn: { id: turnId, status: 'completed' },
                }));
            }
        } else if (request.method === 'thread/goal/get') {
            result = { goal: this.goal('active') };
        } else if (request.method === 'thread/settings/update') {
            queueMicrotask(() => this.notify('thread/settings/updated', {
                threadId: this.threadId,
                threadSettings: { model: params.model ?? 'gpt-effective', effort: params.effort ?? 'high' },
            }));
        } else if (request.method === 'turn/steer') {
            result = { turnId: this.activeTurnId };
        } else if (request.method === 'turn/start') {
            this.activeTurnId = 'turn-correction';
            result = { turn: { id: this.activeTurnId } };
        }
        for (const listener of this.listeners) listener({ id: request.id, result });
    }

    private goal(status: string) {
        return {
            threadId: this.threadId, objective: this.objective, status,
            tokenBudget: null, tokensUsed: 10, timeUsedSeconds: 1, createdAt: 1, updatedAt: 2,
        };
    }
}

async function provider(transport: ScriptedTransport): Promise<CodexNativeGoalProvider> {
    const client = new CodexAppServerClient(transport);
    await client.initialize('test');
    return new CodexNativeGoalProvider(client, 100);
}

describe('Codex native goal App Server adapter', () => {
    test('uses thread/goal/set as the native initial goal input', async () => {
        const transport = new ScriptedTransport();
        const codex = await provider(transport);

        const state = await codex.start({
            goalId: 'goal-2007', objective: transport.objective,
            worktreePath: '/home/node/workspace', model: 'gpt-requested', reasoning: 'high',
        });

        assert.equal(state.providerSessionId, 'codex-thread-2007');
        assert.equal(state.objective, transport.objective);
        const methods = transport.sent.map(message => message.method);
        assert.deepEqual(methods.slice(0, 4), ['initialize', 'initialized', 'thread/start', 'thread/goal/set']);
        assert.equal(methods.includes('turn/start'), false, 'native goal continuation must not be emulated as a one-shot turn');
        const set = transport.sent.find(message => message.method === 'thread/goal/set');
        assert.deepEqual(set?.params, {
            threadId: 'codex-thread-2007', objective: transport.objective, status: 'active',
        });
    });

    test('resumes and verifies the same persisted goal without setting it again', async () => {
        const transport = new ScriptedTransport();
        const codex = await provider(transport);
        const state = await codex.resume({
            goalId: 'goal-2007', providerSessionId: 'codex-thread-2007',
            objective: transport.objective, worktreePath: '/home/node/workspace',
        });

        assert.equal(state.providerSessionId, 'codex-thread-2007');
        assert.deepEqual(transport.sent.map(message => message.method).slice(-2), ['thread/resume', 'thread/goal/get']);
        assert.equal(transport.sent.some(message => message.method === 'thread/goal/set'), false);
    });

    test('steers the active turn in order and pauses only after its safe boundary', async () => {
        const transport = new ScriptedTransport();
        const codex = await provider(transport);
        await codex.start({ goalId: 'goal-2007', objective: transport.objective, worktreePath: '/home/node/workspace' });
        transport.notify('turn/started', {
            threadId: 'codex-thread-2007', turn: { id: transport.activeTurnId, status: 'inProgress' },
        });

        await codex.steer({ sequence: 1, text: 'Correct course.' });
        const steer = transport.sent.find(message => message.method === 'turn/steer');
        assert.equal(steer?.params?.expectedTurnId, 'turn-native-goal');
        assert.equal(steer?.params?.clientUserMessageId, 'propr:codex-thread-2007:steer:1');
        await codex.pauseAtSafeBoundary();
        assert.equal(transport.sent.some(message => message.method === 'turn/interrupt'), false);
    });

    test('reports effective model acknowledgement and cancels separately', async () => {
        const transport = new ScriptedTransport();
        const codex = await provider(transport);
        await codex.start({ goalId: 'goal-2007', objective: transport.objective, worktreePath: '/home/node/workspace' });
        transport.notify('turn/started', {
            threadId: 'codex-thread-2007', turn: { id: 'turn-cancel', status: 'inProgress' },
        });

        assert.deepEqual(await codex.requestModel('gpt-new', 'xhigh'), {
            requestedModel: 'gpt-new', requestedReasoning: 'xhigh',
            effectiveModel: 'gpt-new', effectiveReasoning: 'xhigh', acknowledged: true,
        });
        await codex.cancel();
        const methods = transport.sent.map(message => message.method);
        assert.ok(methods.indexOf('thread/goal/clear') < methods.indexOf('turn/interrupt'));
    });

    test('classifies provider-native output categories', () => {
        assert.equal(classifyCodexGoalNotification({ method: 'item/agentMessage/delta' }), 'assistant');
        assert.equal(classifyCodexGoalNotification({ method: 'item/commandExecution/outputDelta' }), 'terminal');
        assert.equal(classifyCodexGoalNotification({ method: 'item/completed', params: { item: { type: 'mcpToolCall' } } }), 'tool');
        assert.equal(classifyCodexGoalNotification({ method: 'turn/plan/updated' }), 'plan');
        assert.equal(classifyCodexGoalNotification({ method: 'thread/tokenUsage/updated' }), 'usage');
        assert.equal(classifyCodexGoalNotification({ method: 'thread/goal/updated' }), 'checkpoint');
        assert.equal(classifyCodexGoalNotification({ method: 'thread/status/changed' }), 'status');
    });
});
