import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { GOAL_CONTINUE_INPUT } from '../packages/core/src/goals.ts';
import { probeGoalCapability } from '../packages/core/src/agents/goalCapabilities.ts';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import {
    antigravityGoalConversationLog,
    runAntigravityGoalProtocol,
    type StartAntigravitySegment,
} from '../packages/core/src/agents/impl/antigravityNativeGoal.ts';
import {
    ANTIGRAVITY_GOAL_COMPLETE_MARKER,
    AntigravityGoalStream,
    sumAntigravityStepUsage,
    type AntigravityGoalSegment,
    type AntigravitySegmentResult,
} from '../packages/core/src/agents/impl/antigravityGoalStream.ts';
import { splitAntigravityInvocations } from '../packages/core/src/agents/impl/utils/antigravityInvocations.ts';
import type {
    Agent,
    AgentConfig,
    AgentTaskOptions,
    GoalCheckpointOutcome,
    GoalControlSnapshot,
    GoalExecutionControl,
} from '../packages/core/src/agents/types.ts';

const COMMAND = '/goal Add subtract(a, b) to math.js';
const CHECKPOINT = '{"checkpointReady":true,"message":"feat(math): add subtract","include":["math.js"]}';

interface ScriptedStep {
    /** Agent text completed by this step, if any. */
    text?: string;
    /** Ends the invocation on its own with this result. */
    result?: AntigravitySegmentResult;
}

/**
 * One scripted `agy` invocation: it reports its conversation, then completes a
 * step per poll. An interrupt ends it with the CLI's interrupted error result.
 */
class ScriptedSegment implements AntigravityGoalSegment {
    conversationId?: string;
    model = 'gemini-3.8-flash-medium';
    stepActive = false;
    stepCompleted = false;
    result?: AntigravitySegmentResult;
    exited = false;
    errorText?: string;
    tokenUsage = { input_tokens: 10, output_tokens: 1 };
    interrupts = 0;
    stepsBeforeInterrupt?: number;
    private consumed = 0;
    private texts: string[] = [];

    constructor(
        readonly message: string,
        readonly options: { conversationId?: string; launch: boolean },
        private readonly steps: ScriptedStep[],
        conversationId: string,
    ) {
        this.conversationId = conversationId;
    }

    get textCursor(): number { return this.texts.length; }
    textsAfter(cursor: number): string[] { return this.texts.slice(cursor); }

    interrupt(): void {
        this.interrupts += 1;
        this.stepsBeforeInterrupt ??= this.consumed;
        this.result = { status: 'error', response: '' };
        this.errorText = 'error: interrupted';
        this.exited = true;
    }

    async waitForActivity(): Promise<void> {
        if (this.exited) return;
        const step = this.steps.shift();
        if (!step) {
            this.result = { status: 'error', response: '' };
            this.errorText = 'error: script exhausted';
            this.exited = true;
            return;
        }
        this.stepCompleted = true;
        this.consumed += 1;
        if (step.text) this.texts.push(step.text);
        if (step.result) {
            this.result = step.result;
            this.exited = true;
        }
    }

    async waitForExit(): Promise<void> {}
}

interface Harness {
    control: GoalExecutionControl;
    snapshot: GoalControlSnapshot;
    delivered: Array<[string, string]>;
    published: string[];
    rejected: string[];
    undeliverable: string[];
    sessions: string[];
}

function harness(outcome: GoalCheckpointOutcome = { accepted: true, commitSha: 'abc1234' }): Harness {
    const state: Harness = {
        snapshot: { desiredState: 'running', requestedModel: 'antigravity-gemini-3.8-flash-medium', pendingInputs: [], controlGeneration: 1 },
        delivered: [], published: [], rejected: [], undeliverable: [], sessions: [],
        control: undefined as never,
    };
    state.control = {
        load: async () => ({ ...state.snapshot, pendingInputs: [...state.snapshot.pendingInputs] }),
        heartbeat: async () => undefined,
        setActiveTurn: async () => undefined,
        markInputDelivered: async (inputId, turnId) => {
            state.delivered.push([inputId, turnId]);
            state.snapshot.pendingInputs = state.snapshot.pendingInputs.filter(input => input.id !== inputId);
        },
        markInputUndeliverable: async inputId => {
            state.undeliverable.push(inputId);
            state.snapshot.pendingInputs = state.snapshot.pendingInputs.filter(input => input.id !== inputId);
        },
        publishCheckpoint: async request => { state.published.push(request.commitMessage); return outcome; },
        rejectCheckpoint: async request => { state.rejected.push(request.error); },
        appendOutput: async () => undefined,
    };
    return state;
}

function taskOptions(state: Harness, overrides: Partial<AgentTaskOptions> = {}): AgentTaskOptions {
    return {
        worktreePath: '/tmp/worktree', issueRef: { number: 0, repoOwner: 'acme', repoName: 'repo' },
        prompt: COMMAND, githubToken: 'token', executionMode: 'goal', nativeGoalObjective: COMMAND,
        goalControl: state.control,
        onSessionId: sessionId => { state.sessions.push(sessionId); },
        ...overrides,
    };
}

function scripted(scripts: ScriptedStep[][], conversationId = 'agy-conversation') {
    const segments: ScriptedSegment[] = [];
    const start: StartAntigravitySegment = (message, options) => {
        const segment = new ScriptedSegment(message, options, scripts[segments.length] ?? [], conversationId);
        segments.push(segment);
        return segment;
    };
    return { segments, start };
}

const completed = (text = `Done.\n\n${ANTIGRAVITY_GOAL_COMPLETE_MARKER}`): ScriptedStep => ({
    text, result: { status: 'success', response: text },
});

describe('Antigravity native goal protocol', () => {
    test('launches the native /goal with the delivery context and completes on the goal marker', async () => {
        const state = harness();
        const { segments, start } = scripted([[{}, completed()]]);
        const result = await runAntigravityGoalProtocol(start, taskOptions(state, {
            initialControlInputId: 'context-1', initialControlInputMessage: 'ProPR delivery context',
        }), COMMAND);

        assert.equal(result.status, 'completed');
        assert.equal(segments.length, 1);
        assert.equal(segments[0].message, `${COMMAND}\n\nProPR delivery context`);
        assert.deepEqual(segments[0].options, { conversationId: undefined, launch: true });
        assert.deepEqual(state.sessions, ['agy-conversation']);
        assert.deepEqual(state.delivered, [['context-1', 'agy-conversation:1']]);
        assert.equal(result.conversationId, 'agy-conversation');
    });

    test('a checkpoint ends the turn at a step boundary and the same conversation resumes with its acknowledgement', async () => {
        const state = harness();
        const { segments, start } = scripted([
            [{ text: `Subtract added.\n${CHECKPOINT}` }, {}],
            [completed()],
        ]);
        const result = await runAntigravityGoalProtocol(start, taskOptions(state), COMMAND);

        assert.equal(result.status, 'completed');
        assert.equal(segments[0].interrupts, 1);
        assert.deepEqual(state.published, ['feat(math): add subtract']);
        assert.deepEqual(segments[1].options, { conversationId: 'agy-conversation', launch: false });
        assert.match(segments[1].message, /published your checkpoint as commit abc1234/);
    });

    test('async relaunch preparation preserves pending input until the new conversation invocation accepts it', async () => {
        const state = harness();
        const { segments, start } = scripted([[{}, {}, {}], [completed()]]);
        let release!: () => void;
        let preparing!: () => void;
        const ready = new Promise<void>(resolve => { preparing = resolve; });
        const running = runAntigravityGoalProtocol(async (message, options) => {
            if (segments.length === 1) {
                preparing();
                await new Promise<void>(resolve => { release = resolve; });
            }
            return start(message, options);
        }, taskOptions(state), COMMAND);
        state.snapshot.pendingInputs = [{ id: 'input-1', message: 'Also add multiply(a, b).' }];
        await ready;
        assert.equal(segments.length, 1);
        assert.deepEqual(state.delivered, []);
        assert.equal(state.snapshot.pendingInputs.length, 1);
        release();
        assert.equal((await running).status, 'completed');
        assert.deepEqual(state.delivered, [['input-1', 'agy-conversation:2']]);
    });

    test('failed async relaunch preparation leaves input pending for a later attempt', async () => {
        const state = harness();
        const { segments, start } = scripted([[{}, {}, {}]]);
        const running = runAntigravityGoalProtocol(async (message, options) => {
            if (segments.length === 1) throw new Error('Scoped token unavailable');
            return start(message, options);
        }, taskOptions(state), COMMAND);
        state.snapshot.pendingInputs = [{ id: 'input-1', message: 'Keep this instruction.' }];
        await assert.rejects(running, /Scoped token unavailable/);
        assert.equal(segments.length, 1);
        assert.deepEqual(state.delivered, []);
        assert.deepEqual(state.undeliverable, []);
        assert.equal(state.snapshot.pendingInputs[0].id, 'input-1');
    });

    test('a rejected checkpoint is fed back instead of committed', async () => {
        const state = harness();
        const { segments, start } = scripted([
            [{ text: '{"checkpointReady":true,"message":""}' }, {}],
            [completed()],
        ]);
        await runAntigravityGoalProtocol(start, taskOptions(state), COMMAND);

        assert.equal(state.published.length, 0);
        assert.equal(state.rejected.length, 1);
        assert.match(segments[1].message, /rejected your checkpoint declaration/);
    });

    test('a final checkpoint beside the goal marker is published without interrupting completion', async () => {
        const state = harness();
        const text = `Verified.\n${CHECKPOINT}\n${ANTIGRAVITY_GOAL_COMPLETE_MARKER}`;
        const { segments, start } = scripted([[completed(text)]]);
        const result = await runAntigravityGoalProtocol(start, taskOptions(state), COMMAND);

        assert.equal(result.status, 'completed');
        assert.equal(segments.length, 1);
        assert.equal(segments[0].interrupts, 0);
        assert.deepEqual(state.published, ['feat(math): add subtract']);
    });

    test('operator input interrupts the running goal and is delivered verbatim to the resumed conversation', async () => {
        const state = harness();
        const { segments, start } = scripted([[{}, {}, {}], [completed()]]);
        const running = runAntigravityGoalProtocol(start, taskOptions(state), COMMAND);
        state.snapshot.pendingInputs = [{ id: 'input-1', message: 'Also add multiply(a, b).' }];
        const result = await running;

        assert.equal(result.status, 'completed');
        assert.equal(segments[0].interrupts, 1);
        assert.equal(segments[1].message, 'Also add multiply(a, b).');
        assert.deepEqual(state.delivered, [['input-1', 'agy-conversation:2']]);
    });

    test('a launch is not interrupted before its first finished step', async () => {
        const state = harness();
        const { segments, start } = scripted([[{}, {}], [completed()]]);
        const running = runAntigravityGoalProtocol(start, taskOptions(state), COMMAND);
        state.snapshot.pendingInputs = [{ id: 'input-1', message: 'Queued before launch.' }];
        await running;

        assert.equal(segments[0].stepsBeforeInterrupt, 1);
        assert.equal(segments[1].message, 'Queued before launch.');
    });

    test('a pause that lands as the goal completes keeps the completion', async () => {
        const state = harness();
        const { start } = scripted([[completed()]]);
        const running = runAntigravityGoalProtocol(start, taskOptions(state), COMMAND);
        state.snapshot.desiredState = 'paused';
        assert.equal((await running).status, 'completed');
    });

    test('input still queued when the goal completes is settled as undeliverable', async () => {
        const state = harness();
        const { start } = scripted([[completed()]]);
        const running = runAntigravityGoalProtocol(start, taskOptions(state), COMMAND);
        state.snapshot.pendingInputs = [{ id: 'late-input', message: 'Too late.' }];
        assert.equal((await running).status, 'completed');
        assert.deepEqual(state.undeliverable, ['late-input']);
    });

    test('a rejected final checkpoint beside the goal marker is recorded and the goal completes', async () => {
        // The worker's final checkpoint still publishes every remaining change.
        const state = harness();
        const text = `Done.\n{"checkpointReady":true,"message":""}\n${ANTIGRAVITY_GOAL_COMPLETE_MARKER}`;
        const { start } = scripted([[completed(text)]]);
        assert.equal((await runAntigravityGoalProtocol(start, taskOptions(state), COMMAND)).status, 'completed');
        assert.equal(state.rejected.length, 1);
    });

    test('repeatedly rejected checkpoints fail instead of looping', async () => {
        const state = harness();
        const rejected = (): ScriptedStep[] => [{ text: '{"checkpointReady":true,"message":""}' }, {}];
        const { segments, start } = scripted([rejected(), rejected(), rejected(), rejected(), rejected()]);
        const result = await runAntigravityGoalProtocol(start, taskOptions(state), COMMAND);
        assert.equal(result.status, 'failed');
        assert.match(result.error ?? '', /checkpoints that ProPR rejected/);
        assert.equal(segments.length, 4);
    });

    test('pause stops at a boundary without starting another invocation', async () => {
        const state = harness();
        const { segments, start } = scripted([[{}, {}, {}]]);
        const running = runAntigravityGoalProtocol(start, taskOptions(state), COMMAND);
        state.snapshot.desiredState = 'paused';
        const result = await running;

        assert.equal(result.status, 'interrupted');
        assert.equal(segments.length, 1);
        assert.equal(segments[0].interrupts, 1);
    });

    test('a resumed attempt continues the saved conversation with its pending feedback', async () => {
        const state = harness();
        const { segments, start } = scripted([[completed()]]);
        await runAntigravityGoalProtocol(start, taskOptions(state, {
            resumeConversationId: 'agy-conversation', initialGoalFeedback: 'ProPR accepted your checkpoint.',
        }), COMMAND);

        assert.deepEqual(segments[0].options, { conversationId: 'agy-conversation', launch: false });
        assert.equal(segments[0].message, 'ProPR accepted your checkpoint.');
        // Every attempt reports its confirmed identity once, so the worker acknowledges controls.
        assert.deepEqual(state.sessions, ['agy-conversation']);
    });

    test('a resumed attempt without feedback or input nudges the goal to continue', async () => {
        const state = harness();
        const { segments, start } = scripted([[completed()]]);
        await runAntigravityGoalProtocol(start, taskOptions(state, { resumeConversationId: 'agy-conversation' }), COMMAND);
        assert.equal(segments[0].message, GOAL_CONTINUE_INPUT);
    });

    test('repeated turn ends without the goal marker fail instead of looping', async () => {
        const state = harness();
        const idle = (): ScriptedStep[] => [{ text: 'Stopping here.', result: { status: 'success', response: 'Stopping here.' } }];
        const { segments, start } = scripted([idle(), idle(), idle(), idle(), idle()]);
        const result = await runAntigravityGoalProtocol(start, taskOptions(state), COMMAND);

        assert.equal(result.status, 'failed');
        assert.match(result.error ?? '', /without marking the native goal complete/);
        assert.equal(segments.length, 4);
    });

    test('a provider failure is reported with the CLI error line', async () => {
        const state = harness();
        const { start } = scripted([[{ result: { status: 'error', response: '' } }]]);
        const result = await runAntigravityGoalProtocol(start, taskOptions(state), COMMAND);
        assert.equal(result.status, 'failed');
    });

    test('a resume that reports a different conversation is refused', async () => {
        const state = harness();
        const { start } = scripted([[completed()]], 'other-conversation');
        await assert.rejects(
            runAntigravityGoalProtocol(start, taskOptions(state, { resumeConversationId: 'agy-conversation' }), COMMAND),
            /resumed conversation "other-conversation" instead of "agy-conversation"/,
        );
    });
});

describe('Antigravity goal accounting and capability', () => {
    test('step usage, not the conversation-cumulative result usage, measures one invocation', () => {
        assert.deepEqual(sumAntigravityStepUsage([
            { input_tokens: 100, output_tokens: 5, thinking_tokens: 2, cache_read_tokens: 40 },
            { input_tokens: 50, output_tokens: 3 },
        ]), { input_tokens: 150, output_tokens: 8, cache_read_input_tokens: 40, reasoning_output_tokens: 2 });
    });

    test('a recorded goal stream splits into its invocations at each init envelope', () => {
        const init = '{"event": "init", "conversation_id": "c", "init": {"model": "m"}}';
        const invocations = splitAntigravityInvocations(['entrypoint banner', init, 'a', init, 'b'].join('\n'));
        assert.equal(invocations.length, 2);
        assert.match(invocations[0], /^entrypoint banner\n\{"event": "init"/);
        assert.equal(invocations[1], `${init}\nb`);
    });

    test('runtimes whose CLI lacks the native /goal command are not goal capable', async () => {
        const capability = await probeGoalCapability({
            config: { id: 'agy', alias: 'antigravity', type: 'antigravity', enabled: true, dockerImage: 'image' } as AgentConfig,
            goalCapable: true,
        } as Agent, async () => ({
            stdout: '--print\n--conversation\n--output-format\n--disable-slash-commands\n===PROPR-ANTIGRAVITY-GOAL-PROBE===\n0\n',
            stderr: '', exitCode: 0, messageTimestamps: new Map(),
        }));
        assert.equal(capability.goalCapable, false);
        assert.match(capability.reason ?? '', /native \/goal command/);
    });
});

describe('Antigravity goal stream adapter', () => {
    function fakeChild() {
        const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; signals: string[]; kill(signal: string): boolean };
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new PassThrough();
        child.signals = [];
        child.kill = signal => { child.signals.push(signal); return true; };
        return child;
    }
    const line = (value: unknown) => `${JSON.stringify(value)}\n`;
    const step = (index: number, state: string, extra: Record<string, unknown> = {}) => line({
        event: 'step_update', step_update: { conversation_id: 'agy', step_index: index, state, step_type: 'agent_response', ...extra },
    });

    test('assembles fragmented narration, tracks step boundaries, and reports the terminal result', async () => {
        const child = fakeChild();
        const recorded: string[] = [];
        const stream = new AntigravityGoalStream(child as unknown as ChildProcess, { append: (value: string) => { recorded.push(value); } } as never);
        child.stdout.write(line({ event: 'init', conversation_id: 'agy', init: { model: 'gemini-3.8-flash-medium' } }));
        child.stdout.write(step(1, 'ACTIVE', { text_delta: 'Adding sub' }));
        await stream.waitForActivity(50);
        assert.equal(stream.conversationId, 'agy');
        assert.equal(stream.stepActive, true);
        assert.deepEqual(stream.textsAfter(0), []);

        child.stdout.write(step(1, 'DONE', { text_delta: 'tract.', usage: { input_tokens: 30, output_tokens: 2 } }));
        child.stdout.write(line({ event: 'step_update', step_update: { conversation_id: 'agy', step_index: 2, state: 'DONE', step_type: 'tool', usage: { input_tokens: 10 } } }));
        child.stdout.write(line({ event: 'result', result: { conversation_id: 'agy', status: 'ERROR', response: '', usage: { input_tokens: 999 } } }));
        child.stderr.write('Switching to node user...\nerror: interrupted\n');
        stream.interrupt();
        child.stdout.end();
        child.stderr.end();
        await new Promise(resolve => setImmediate(resolve));
        child.emit('close', 130);
        await stream.waitForExit();

        assert.deepEqual(child.signals, ['SIGINT']);
        assert.equal(stream.stepActive, false);
        assert.deepEqual(stream.textsAfter(0), ['Adding subtract.']);
        assert.deepEqual(stream.result, { status: 'error', response: '' });
        assert.equal(stream.errorText, 'error: interrupted');
        assert.deepEqual(stream.tokenUsage, { input_tokens: 40, output_tokens: 2, cache_read_input_tokens: 0, reasoning_output_tokens: 0 });
        assert.equal(stream.exited, true);
        assert.equal(recorded.length, 5);
    });

    test("a goal attempt's conversation log keeps narration from interrupted invocations", () => {
        const init = line({ event: 'init', conversation_id: 'agy', init: { model: 'gemini-3.8-flash-medium' } });
        const raw = [
            init, step(1, 'DONE', { text_delta: 'Adding subtract.' }),
            line({ event: 'result', result: { conversation_id: 'agy', status: 'ERROR', response: '' } }),
            init, step(3, 'DONE', { text_delta: 'Applying the correction.' }),
            line({ event: 'result', result: { conversation_id: 'agy', status: 'SUCCESS', response: 'Applying the correction.' } }),
        ].join('');
        const texts = antigravityGoalConversationLog(raw).map(event => JSON.stringify(event));
        assert.equal(texts.length, 2);
        assert.match(texts[0], /Adding subtract\./);
        assert.match(texts[1], /Applying the correction\./);
    });
});
