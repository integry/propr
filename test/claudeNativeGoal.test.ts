import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import {
  CLAUDE_GOAL_CONTEXT_PREAMBLE,
  claudeGoalCondition,
  claudeSessionTranscriptPath,
  readClaudeGoalState,
  runClaudeGoalProtocol,
  type ClaudeGoalSession,
  type ClaudeTurnResult,
} from '../packages/core/src/agents/impl/claudeNativeGoal.ts';
import { buildDockerArgs } from '../packages/core/src/agents/impl/utils/dockerArgsBuilder.ts';
import { GOAL_CONTINUE_INPUT } from '../packages/core/src/goals.ts';
import type {
  AgentConfig,
  AgentTaskOptions,
  GoalControlSnapshot,
  GoalExecutionControl,
} from '../packages/core/src/agents/types.ts';

const COMMAND = '/goal Ship it';
const CONDITION = 'Ship it';
const directory = mkdtempSync(path.join(tmpdir(), 'claude-native-goal-'));
mkdirSync(path.dirname(claudeSessionTranscriptPath(directory, 'probe')), { recursive: true });

after(async () => {
  rmSync(directory, { recursive: true, force: true });
  const { closeConnection } = await import('../packages/core/src/db/connection.ts');
  await closeConnection();
});

function goalStatus(attachment: Record<string, unknown>): string {
  return `${JSON.stringify({
    type: 'attachment',
    timestamp: new Date('2026-09-19T09:00:00.000Z').toISOString(),
    attachment: { type: 'goal_status', condition: CONDITION, ...attachment },
  })}\n`;
}

const GOAL_SET = goalStatus({ met: false, sentinel: true });
const GOAL_NOT_MET = goalStatus({ met: false, reason: 'part2.txt is missing' });
const GOAL_MET = goalStatus({ met: true, reason: 'Both files exist' });

/** Scripted stand-in for a live `claude -p --input-format stream-json` session. */
class FakeClaudeSession implements ClaudeGoalSession {
  sent: string[] = [];
  interrupts = 0;
  goalRecords: Array<Record<string, unknown>> = [];
  closeError: Error | null = null;
  private results: ClaudeTurnResult[] = [];
  private texts: string[] = [];

  constructor(
    readonly transcriptPath: string,
    private readonly script: (session: FakeClaudeSession, text: string) => void,
    private readonly onInterrupt: (session: FakeClaudeSession) => void = session => session.endTurn(),
  ) {}

  get textCursor(): number { return this.texts.length; }
  get hasResult(): boolean { return this.results.length > 0; }
  textsAfter(cursor: number): string[] { return this.texts.slice(cursor); }
  appendGoalRecord(goal: Record<string, unknown>): void { this.goalRecords.push(goal); }
  takeResult(): ClaudeTurnResult | undefined { return this.results.shift(); }

  send(text: string): void {
    this.sent.push(text);
    if (text.startsWith('/goal ') && text !== '/goal clear') this.transcript(GOAL_SET);
    if (text === '/goal clear') this.transcript(goalStatus({ met: true, sentinel: true }));
    setImmediate(() => this.script(this, text));
  }

  interrupt(): void {
    this.interrupts += 1;
    setImmediate(() => this.onInterrupt(this));
  }

  say(text: string): void { this.texts.push(text); }
  transcript(line: string): void { appendFileSync(this.transcriptPath, line); }
  endTurn(result: Partial<ClaudeTurnResult> = {}): void { this.results.push({ isError: false, subtype: 'success', ...result }); }

  async waitForActivity(timeoutMs: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, Math.min(timeoutMs, 2)));
  }

  async waitForResult(timeoutMs: number): Promise<ClaudeTurnResult> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = this.takeResult();
      if (result) return result;
      await this.waitForActivity(2);
    }
    throw new Error('fake turn did not finish');
  }
}

interface FakeControl extends GoalExecutionControl {
  delivered: Array<{ inputId: string; turnId: string }>;
  undeliverable: string[];
  published: Array<{ commitMessage: string; include?: string[] }>;
  rejected: string[];
  snapshot: GoalControlSnapshot;
}

function fakeControl(): FakeControl {
  const control: FakeControl = {
    delivered: [],
    undeliverable: [],
    published: [],
    rejected: [],
    snapshot: { desiredState: 'running', requestedModel: 'claude-opus-5', pendingInputs: [], controlGeneration: 0 },
    load: async () => {
      const snapshot = { ...control.snapshot };
      control.snapshot = { ...control.snapshot, pendingInputs: [] };
      return snapshot;
    },
    heartbeat: async () => {},
    setActiveTurn: async () => {},
    markInputDelivered: async (inputId, turnId) => { control.delivered.push({ inputId, turnId }); },
    markInputUndeliverable: async inputId => { control.undeliverable.push(inputId); },
    publishCheckpoint: async request => {
      control.published.push({ commitMessage: request.commitMessage, include: request.include });
      return { accepted: true, commitSha: 'abc123' };
    },
    rejectCheckpoint: async request => { control.rejected.push(request.error); },
    appendOutput: async () => {},
  };
  return control;
}

let sessionCounter = 0;
function session(
  script: (session: FakeClaudeSession, text: string) => void,
  options: { transcript?: string; onInterrupt?: (session: FakeClaudeSession) => void } = {},
): { fake: FakeClaudeSession; sessionId: string } {
  sessionCounter += 1;
  const sessionId = `session-${sessionCounter}`;
  const transcriptPath = claudeSessionTranscriptPath(directory, sessionId);
  if (options.transcript !== undefined) {
    writeFileSync(transcriptPath, options.transcript);
  }
  return { fake: new FakeClaudeSession(transcriptPath, script, options.onInterrupt), sessionId };
}

function run(fake: FakeClaudeSession, sessionId: string, control: FakeControl, options: Partial<AgentTaskOptions> = {}) {
  return runClaudeGoalProtocol(fake, {
    worktreePath: '/tmp/worktree', issueRef: { number: 0, repoOwner: 'acme', repoName: 'repo' },
    prompt: COMMAND, githubToken: 'token', executionMode: 'goal', nativeGoalObjective: COMMAND,
    goalControl: control, ...options,
  }, { command: COMMAND, condition: CONDITION, sessionId, transcriptPath: fake.transcriptPath, startedAt: Date.now() });
}

describe('Claude native /goal protocol', () => {
  test('reduces transcript goal_status records for the goal condition', () => {
    assert.equal(claudeGoalCondition('/goal  Ship it \n'), 'Ship it');
    assert.equal(readClaudeGoalState('', CONDITION).status, 'none');
    assert.deepEqual(readClaudeGoalState(GOAL_SET + GOAL_NOT_MET, CONDITION), {
      status: 'active', iterations: 1, reason: 'part2.txt is missing', setAt: Date.parse('2026-09-19T09:00:00.000Z'),
    });
    assert.equal(readClaudeGoalState(GOAL_SET + GOAL_NOT_MET + GOAL_MET, CONDITION).status, 'complete');
    assert.equal(readClaudeGoalState(GOAL_SET + goalStatus({ met: true, sentinel: true }), CONDITION).status, 'cleared');
    assert.equal(readClaudeGoalState(GOAL_SET + goalStatus({ met: false, failed: true, reason: 'No repo' }), CONDITION).status, 'failed');
    const otherGoal = GOAL_SET.replace(CONDITION, 'Something else') + GOAL_MET.replace(CONDITION, 'Something else');
    assert.equal(readClaudeGoalState(otherGoal, CONDITION).status, 'none');
  });

  test('a fresh session receives delivery context before the goal is set, then completes when the Stop hook is met', async () => {
    const { fake, sessionId } = session((current, text) => {
      if (text.startsWith(CLAUDE_GOAL_CONTEXT_PREAMBLE)) return current.endTurn({ text: 'Acknowledged.' });
      if (text === COMMAND) {
        current.say('Goal set: Ship it');
        current.transcript(GOAL_MET);
        current.endTurn({ text: 'Shipped.' });
      }
    });
    const control = fakeControl();

    const completion = await run(fake, sessionId, control, {
      initialControlInputId: 'context-1', initialControlInputMessage: 'Launch policy',
    });

    assert.deepEqual(completion, { status: 'completed' });
    assert.deepEqual(fake.sent, [`${CLAUDE_GOAL_CONTEXT_PREAMBLE}\n\nLaunch policy`, COMMAND]);
    assert.deepEqual(control.delivered, [{ inputId: 'context-1', turnId: `${sessionId}:context` }]);
    assert.equal(fake.interrupts, 0);
    assert.deepEqual(fake.goalRecords.map(record => record.status), ['active', 'complete']);
  });

  test('a checkpoint declaration interrupts the turn, publishes, and steers the acknowledgement into the next turn', async () => {
    let turns = 0;
    const { fake, sessionId } = session((current, text) => {
      turns += 1;
      if (text === COMMAND) {
        current.say('{"checkpointReady":true,"message":"feat: first half","include":["part1.txt"]}');
        return;
      }
      assert.match(text, /ProPR accepted and published your checkpoint as commit abc123/);
      current.transcript(GOAL_MET);
      current.endTurn();
    }, { onInterrupt: current => { current.transcript(GOAL_NOT_MET); current.endTurn(); } });
    const control = fakeControl();

    const completion = await run(fake, sessionId, control);

    assert.deepEqual(completion, { status: 'completed' });
    assert.equal(fake.interrupts, 1);
    assert.equal(turns, 2);
    assert.deepEqual(control.published, [{ commitMessage: 'feat: first half', include: ['part1.txt'] }]);
    assert.equal(fake.sent.includes('/goal clear'), false, 'a checkpoint boundary must keep the goal set');
  });

  test('a checkpoint declared while the turn is being registered and ending with it is still published', async () => {
    const { fake, sessionId } = session((current, text) => {
      if (text === COMMAND) {
        current.say('{"checkpointReady":true,"message":"feat: first half","include":["part1.txt"]}');
        current.transcript(GOAL_NOT_MET);
        current.endTurn();
        return;
      }
      assert.match(text, /ProPR accepted and published your checkpoint as commit abc123/);
      current.transcript(GOAL_MET);
      current.endTurn();
    });
    const control = fakeControl();
    // Let the whole turn land in the buffer before observation starts.
    control.setActiveTurn = async () => { await new Promise(resolve => setTimeout(resolve, 10)); };

    assert.deepEqual(await run(fake, sessionId, control), { status: 'completed' });
    assert.deepEqual(control.published, [{ commitMessage: 'feat: first half', include: ['part1.txt'] }]);
  });

  test('a malformed checkpoint declaration is rejected and the agent is told to correct it', async () => {
    const { fake, sessionId } = session((current, text) => {
      if (text === COMMAND) return current.say('{"checkpointReady":true,"message":""}');
      assert.match(text, /ProPR rejected your checkpoint declaration/);
      current.transcript(GOAL_MET);
      current.endTurn();
    }, { onInterrupt: current => current.endTurn({ isError: true, subtype: 'error_during_execution' }) });
    const control = fakeControl();

    assert.deepEqual(await run(fake, sessionId, control), { status: 'completed' });
    assert.equal(control.published.length, 0);
    assert.match(control.rejected[0], /message must be a non-empty string/);
  });

  test('running input is steered into the live turn and acknowledged against it', async () => {
    const control = fakeControl();
    const { fake, sessionId } = session((current, text) => {
      if (text === COMMAND) {
        control.snapshot.pendingInputs = [{ id: 'input-1', message: 'Use the existing API shape.' }];
        return;
      }
      if (text === 'Use the existing API shape.') {
        current.transcript(GOAL_MET);
        current.endTurn();
      }
    });

    assert.deepEqual(await run(fake, sessionId, control), { status: 'completed' });
    assert.deepEqual(fake.sent, [COMMAND, 'Use the existing API shape.']);
    assert.deepEqual(control.delivered, [{ inputId: 'input-1', turnId: `${sessionId}:1` }]);
    assert.equal(fake.interrupts, 0);
  });

  test('pause interrupts the live turn and keeps the goal set for exact-session resume', async () => {
    const control = fakeControl();
    const { fake, sessionId } = session((_current, text) => {
      if (text === COMMAND) control.snapshot.desiredState = 'paused';
    });

    const completion = await run(fake, sessionId, control);

    assert.equal(completion.status, 'interrupted');
    assert.equal(fake.interrupts, 1);
    assert.deepEqual(fake.sent, [COMMAND]);
    assert.equal(fake.goalRecords.at(-1)?.status, 'paused');
  });

  test('cancel interrupts the live turn and clears the native goal', async () => {
    const control = fakeControl();
    const { fake, sessionId } = session((current, text) => {
      if (text === COMMAND) control.snapshot.desiredState = 'cancelled';
      if (text === '/goal clear') current.endTurn();
    });

    const completion = await run(fake, sessionId, control);

    assert.equal(completion.status, 'interrupted');
    assert.deepEqual(fake.sent, [COMMAND, '/goal clear']);
    assert.equal(fake.goalRecords.at(-1)?.status, 'cleared');
  });

  test('pause during the delivery-context turn interrupts it and never sets the goal', async () => {
    const control = fakeControl();
    const { fake, sessionId } = session((_current, text) => {
      if (text.startsWith(CLAUDE_GOAL_CONTEXT_PREAMBLE)) control.snapshot.desiredState = 'paused';
    });

    const completion = await run(fake, sessionId, control, {
      initialControlInputId: 'context-1', initialControlInputMessage: 'Launch policy',
    });

    assert.equal(completion.status, 'interrupted');
    assert.equal(fake.interrupts, 1);
    assert.deepEqual(fake.sent, [`${CLAUDE_GOAL_CONTEXT_PREAMBLE}\n\nLaunch policy`]);
    assert.deepEqual(control.delivered, []);
  });

  test('cancel requested as the delivery-context turn finishes does not send the goal', async () => {
    const control = fakeControl();
    const { fake, sessionId } = session((current, text) => {
      if (!text.startsWith(CLAUDE_GOAL_CONTEXT_PREAMBLE)) return;
      control.snapshot.desiredState = 'cancelled';
      current.endTurn({ text: 'Acknowledged.' });
    });

    const completion = await run(fake, sessionId, control, {
      initialControlInputId: 'context-1', initialControlInputMessage: 'Launch policy',
    });

    assert.equal(completion.status, 'interrupted');
    assert.equal(fake.sent.includes(COMMAND), false);
  });

  test('a restored session cancelled before observation clears its live goal', async () => {
    const control = fakeControl();
    control.snapshot.desiredState = 'cancelled';
    const { fake, sessionId } = session((current, text) => {
      if (text === '/goal clear') current.endTurn();
    }, { transcript: GOAL_SET + GOAL_NOT_MET });

    const completion = await run(fake, sessionId, control, { resumeSessionId: sessionId });

    assert.equal(completion.status, 'interrupted');
    assert.deepEqual(fake.sent, ['/goal clear']);
    assert.equal(fake.goalRecords.at(-1)?.status, 'cleared');
  });

  test('an unreadable transcript after a successful turn is a verification failure, not completion', async () => {
    const { fake, sessionId } = session((current, text) => {
      if (text !== COMMAND) return;
      // A directory in place of the transcript file makes every read fail.
      rmSync(current.transcriptPath, { force: true });
      mkdirSync(current.transcriptPath);
      current.endTurn();
    });

    const completion = await run(fake, sessionId, fakeControl());

    assert.equal(completion.status, 'failed');
    assert.match(completion.error || '', /Could not verify the Claude native goal verdict/);
  });

  test('a resumed session with a live goal continues without setting the goal again', async () => {
    const { fake, sessionId } = session((current, text) => {
      assert.equal(text, 'ProPR accepted and published your checkpoint as commit abc.');
      current.transcript(GOAL_MET);
      current.endTurn();
    }, { transcript: GOAL_SET + GOAL_NOT_MET });

    const completion = await run(fake, sessionId, fakeControl(), {
      resumeSessionId: sessionId, initialGoalFeedback: 'ProPR accepted and published your checkpoint as commit abc.',
    });

    assert.deepEqual(completion, { status: 'completed' });
    assert.equal(fake.sent.some(text => text.startsWith('/goal')), false);
  });

  test('a resumed session delivers checkpoint feedback and a queued input as separate messages', async () => {
    const { fake, sessionId } = session((current, text) => {
      if (text !== 'Also update the changelog.') return;
      current.transcript(GOAL_MET);
      current.endTurn();
    }, { transcript: GOAL_SET + GOAL_NOT_MET });
    const control = fakeControl();

    const completion = await run(fake, sessionId, control, {
      resumeSessionId: sessionId,
      initialGoalFeedback: 'ProPR accepted and published your checkpoint as commit abc.',
      initialControlInputId: 'input-4',
      initialControlInputMessage: 'Also update the changelog.',
    });

    assert.deepEqual(completion, { status: 'completed' });
    assert.deepEqual(fake.sent, [
      'ProPR accepted and published your checkpoint as commit abc.',
      'Also update the changelog.',
    ]);
    assert.deepEqual(control.delivered, [{ inputId: 'input-4', turnId: `${sessionId}:1` }]);
  });

  test('input queued as the turn ends stays pending instead of starting an unobserved turn', async () => {
    const control = fakeControl();
    const { fake, sessionId } = session((current, text) => {
      if (text !== COMMAND) return;
      // The queued input and the turn's final result land together.
      control.snapshot.pendingInputs = [{ id: 'input-5', message: 'Late note.' }];
      current.transcript(GOAL_MET);
      current.endTurn();
    });

    assert.deepEqual(await run(fake, sessionId, control), { status: 'completed' });
    assert.deepEqual(fake.sent, [COMMAND]);
    assert.deepEqual(control.delivered, []);
  });

  test('a resumed session whose goal already completed marks queued input undeliverable', async () => {
    const { fake, sessionId } = session(() => assert.fail('no provider turn should start'), {
      transcript: GOAL_SET + GOAL_MET,
    });
    const control = fakeControl();

    const completion = await run(fake, sessionId, control, {
      resumeSessionId: sessionId, initialControlInputId: 'input-2', initialControlInputMessage: 'Too late',
    });

    assert.deepEqual(completion, { status: 'completed' });
    assert.deepEqual(control.undeliverable, ['input-2']);
    assert.deepEqual(fake.sent, []);
  });

  test('a resumed session without a goal sets it again before steering pending input', async () => {
    const { fake, sessionId } = session((current, text) => {
      if (text !== COMMAND) {
        current.transcript(GOAL_MET);
        current.endTurn();
      }
    }, { transcript: '' });
    const control = fakeControl();

    const completion = await run(fake, sessionId, control, {
      resumeSessionId: sessionId, initialControlInputId: 'input-3', initialControlInputMessage: 'Continue with tests',
    });

    assert.deepEqual(completion, { status: 'completed' });
    assert.deepEqual(fake.sent, [COMMAND, 'Continue with tests']);
    assert.deepEqual(control.delivered, [{ inputId: 'input-3', turnId: `${sessionId}:1` }]);
  });

  test('a goal Claude judges impossible fails with the evaluator reason', async () => {
    const { fake, sessionId } = session((current, text) => {
      if (text !== COMMAND) return;
      current.transcript(goalStatus({ met: false, failed: true, reason: 'The repository is archived' }));
      current.endTurn();
    });

    const completion = await run(fake, sessionId, fakeControl());

    assert.equal(completion.status, 'failed');
    assert.match(completion.error || '', /judged impossible: The repository is archived/);
  });

  test('turn ends that leave the goal unmet are nudged a bounded number of times', async () => {
    const { fake, sessionId } = session(current => {
      current.transcript(GOAL_NOT_MET);
      current.endTurn();
    });

    const completion = await run(fake, sessionId, fakeControl());

    assert.equal(completion.status, 'failed');
    assert.match(completion.error || '', /repeatedly ended its turn/);
    assert.deepEqual(fake.sent, [COMMAND, GOAL_CONTINUE_INPUT, GOAL_CONTINUE_INPUT, GOAL_CONTINUE_INPUT]);
  });

  test('goal docker args keep stdin open for stream-json control and assign or resume the session', () => {
    const config = {
      id: 'claude-1', alias: 'claude', type: 'claude', dockerImage: 'propr/runtime-agent:test',
      configPath: directory, supportedModels: ['claude-opus-5'], defaultModel: 'claude-opus-5',
    } as unknown as AgentConfig;
    const base = { worktreePath: '/tmp/worktree', githubToken: 'token', modelName: 'claude-opus-5', issueNumber: 0, executionMode: 'goal' as const };
    const fresh = buildDockerArgs(config, 1000, { ...base, sessionId: 'session-new' }).join(' ');
    assert.match(fresh, /claude -p --input-format stream-json --session-id session-new --model claude-opus-5 --output-format stream-json --verbose/);
    assert.doesNotMatch(fresh, / -p - |--max-turns|--no-session-persistence/);
    const resumed = buildDockerArgs(config, 1000, { ...base, resumeSessionId: 'session-old', sessionId: 'session-old' }).join(' ');
    assert.match(resumed, /--resume session-old/);
    assert.doesNotMatch(resumed, /--session-id/);
    const task = buildDockerArgs(config, 1000, { ...base, executionMode: 'task' }).join(' ');
    assert.match(task, /claude -p - --no-session-persistence/);
  });
});
