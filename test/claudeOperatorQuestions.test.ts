import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { after, describe, test } from 'node:test';
import { goalBlockerSupport, goalProviderAnswersQuestions } from '../packages/shared/src/goalBlockers.ts';
import {
  ClaudeOperatorQuestions,
  createOperatorQuestionExchange,
  removeOperatorQuestionExchange,
} from '../packages/core/src/agents/impl/claudeOperatorQuestions.ts';
import {
  boundOperatorQuestionLaunch,
  buildOperatorQuestionMcpConfig,
  OPERATOR_QUESTION_EXCHANGE_ROOT,
  OPERATOR_QUESTION_SERVER_NAME,
  operatorQuestionToolTimeoutMs,
  type OperatorQuestionLaunch,
} from '../packages/core/src/agents/impl/utils/operatorQuestionMcpServer.ts';
import { buildDockerArgs } from '../packages/core/src/agents/impl/utils/dockerArgsBuilder.ts';
import { boundGoalQuestionMaxWaitMs } from '../packages/core/src/config/goalQuestionSettings.ts';
import type { AgentConfig, GoalBlockerReport } from '../packages/core/src/agents/types.ts';

const root = mkdtempSync(path.join(tmpdir(), 'propr-operator-test-'));
const children: ChildProcess[] = [];

after(async () => {
  for (const child of children) child.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
  const { closeConnection } = await import('../packages/core/src/db/connection.ts');
  await closeConnection();
});

interface RecordingControl {
  reports: GoalBlockerReport[];
  resolved: Array<{ requestKey: string; resolution: string }>;
  delivered: Array<{ inputId: string; turnId: string }>;
  boundary: number | null;
  reportBlocker(report: GoalBlockerReport): Promise<number | null>;
  resolveBlocker(requestKey: string, resolution: string): Promise<void>;
  markInputDelivered(inputId: string, turnId: string): Promise<void>;
}

function recordingControl(boundary: number | null = 4): RecordingControl {
  const control: RecordingControl = {
    reports: [], resolved: [], delivered: [], boundary,
    reportBlocker: async report => { control.reports.push(report); return control.boundary; },
    resolveBlocker: async (requestKey, resolution) => { control.resolved.push({ requestKey, resolution }); },
    markInputDelivered: async (inputId, turnId) => { control.delivered.push({ inputId, turnId }); },
  };
  return control;
}

/** A JSON-RPC client for the real inline server, launched with the env Claude would pass it. */
function startServer(launch: OperatorQuestionLaunch, overrides: Record<string, string> = {}) {
  const config = JSON.parse(buildOperatorQuestionMcpConfig({
    exchangeDir: `${OPERATOR_QUESTION_EXCHANGE_ROOT}/test`, maxWaitMs: launch.maxWaitMs,
  })) as { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> };
  const server = config.mcpServers[OPERATOR_QUESTION_SERVER_NAME];
  const child = spawn(server.command, server.args, {
    env: { ...process.env, ...server.env, PROPR_OPERATOR_EXCHANGE_DIR: launch.exchangeDir, ...overrides },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  readline.createInterface({ input: child.stdout! }).on('line', line => {
    const message = JSON.parse(line) as { id: number };
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  let nextId = 0;
  const request = (method: string, params: Record<string, unknown> = {}) => new Promise<Record<string, any>>(resolve => { // eslint-disable-line @typescript-eslint/no-explicit-any
    nextId += 1;
    pending.set(nextId, resolve);
    child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: nextId, method, params })}\n`);
  });
  const ask = (args: Record<string, unknown>) => request('tools/call', { name: 'ask_operator', arguments: args })
    .then(message => message.result as { content: Array<{ text: string }>; isError?: boolean });
  return { child, request, ask };
}

async function until<T>(probe: () => Promise<T | undefined> | T | undefined, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('condition was not reached in time');
}

/** Sync the worker side until the server's request has been reported. */
async function reported(questions: ClaudeOperatorQuestions, control: RecordingControl, turnId = 'turn-1', count = 1) {
  return until(async () => {
    await questions.sync(turnId);
    return control.reports.length >= count ? control.reports[count - 1] : undefined;
  });
}

describe('ask_operator tool', () => {
  test('lists one bounded tool whose description forbids secrets', async () => {
    const launch = await createOperatorQuestionExchange(60_000, root);
    const { request } = startServer(launch);
    const initialized = await request('initialize', { protocolVersion: '2025-06-18' });
    assert.equal(initialized.result.serverInfo.name, 'propr-operator');
    const listed = await request('tools/list');
    assert.equal(listed.result.tools.length, 1);
    const [tool] = listed.result.tools;
    assert.equal(tool.name, 'ask_operator');
    assert.deepEqual(tool.inputSchema.required, ['question']);
    assert.equal(tool.inputSchema.properties.question.maxLength, 1000);
    assert.equal(tool.inputSchema.properties.options.minItems, 2);
    assert.equal(tool.inputSchema.properties.options.maxItems, 10);
    assert.match(tool.description, /Never ask for credentials/);
    assert.match(tool.description, /cannot resolve from the goal, the repository, or a sensible default/);
    assert.match(tool.description, /at most 1 minute/);
  });

  test('round trip: the question becomes a fenced send_input blocker and the next input is the tool result', async () => {
    const launch = await createOperatorQuestionExchange(60_000, root);
    const { ask } = startServer(launch);
    const control = recordingControl(4);
    const questions = new ClaudeOperatorQuestions(launch, control, 'session-a');
    const result = ask({ question: 'Which database should the cache use?', options: ['Redis', 'Postgres'] });

    const report = await reported(questions, control);
    assert.equal(report.category, 'question');
    assert.equal(report.source, 'claude_mcp:ask_operator');
    assert.equal(report.summary, 'Which database should the cache use?');
    assert.deepEqual(report.responseActions, ['send_input', 'pause', 'cancel']);
    assert.equal(report.turnId, 'turn-1');
    assert.match(report.requestKey, /^claude:session-a:ask_operator:[0-9a-f-]{36}$/);
    assert.deepEqual(report.questions?.[0].options, ['Redis', 'Postgres']);
    assert.equal(questions.waiting, 1);
    // A repeated sync does not report the same request again.
    await questions.sync('turn-1');
    assert.equal(control.reports.length, 1);

    // Input queued before the question opened is a correction, not the answer.
    assert.equal(await questions.answer({ id: 'old', message: 'unrelated', sequence: 4 }, 'turn-1'), false);
    assert.equal(await questions.answer({ id: 'unordered', message: 'no sequence' }, 'turn-1'), false);
    assert.equal(await questions.answer({ id: 'answer', message: 'Use Postgres.', sequence: 5 }, 'turn-1'), true);

    const answered = await result;
    assert.equal(answered.isError, undefined);
    assert.equal(answered.content[0].text, 'The operator answered:\nUse Postgres.');
    assert.deepEqual(control.delivered, [{ inputId: 'answer', turnId: 'turn-1' }]);
    assert.deepEqual(control.resolved, [{ requestKey: report.requestKey, resolution: 'answered' }]);
    assert.equal(questions.waiting, 0);
    assert.equal(await questions.answer({ id: 'later', message: 'again', sequence: 6 }, 'turn-1'), false);
  });

  test('invalid questions are rejected by the tool before anything is recorded', async () => {
    const launch = await createOperatorQuestionExchange(60_000, root);
    const { ask } = startServer(launch);
    for (const args of [
      {}, { question: '   ' }, { question: 'x'.repeat(1001) },
      { question: 'One option?', options: ['only'] },
      { question: 'Too many?', options: Array.from({ length: 11 }, (_, index) => `option ${index}`) },
      { question: 'Long option?', options: ['a', 'b'.repeat(201)] },
    ]) {
      const result = await ask(args);
      assert.equal(result.isError, true, JSON.stringify(args));
    }
    const control = recordingControl();
    await new ClaudeOperatorQuestions(launch, control, 'session-b').sync('turn-1');
    assert.equal(control.reports.length, 0);
  });

  test('several waiting questions are not answered by one input', async () => {
    const launch = await createOperatorQuestionExchange(60_000, root);
    const { ask } = startServer(launch);
    const control = recordingControl(1);
    const questions = new ClaudeOperatorQuestions(launch, control, 'session-c');
    const first = ask({ question: 'First?' });
    const second = ask({ question: 'Second?' });
    await reported(questions, control, 'turn-1', 2);
    assert.equal(await questions.answer({ id: 'input', message: 'Yes', sequence: 2 }, 'turn-1'), false);
    await questions.closeOpen('turn_ended', 'the turn ended');
    for (const result of await Promise.all([first, second])) {
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /closed without an answer: the turn ended/);
    }
    assert.deepEqual(control.resolved.map(entry => entry.resolution), ['turn_ended', 'turn_ended']);
  });

  test('a question the attempt cannot record (fenced or superseded) fails the tool call cleanly', async () => {
    const launch = await createOperatorQuestionExchange(60_000, root);
    const { ask } = startServer(launch);
    const control = recordingControl(null);
    const questions = new ClaudeOperatorQuestions(launch, control, 'session-d');
    const result = ask({ question: 'Still there?' });
    await reported(questions, control);
    const failed = await result;
    assert.equal(failed.isError, true);
    assert.match(failed.content[0].text, /could not record the question for this goal attempt/);
    assert.equal(questions.waiting, 0);
    assert.deepEqual(control.resolved, []);
  });

  test('a question asked during the acknowledgement-only context turn is declined', async () => {
    const launch = await createOperatorQuestionExchange(60_000, root);
    const { ask } = startServer(launch);
    const control = recordingControl();
    const questions = new ClaudeOperatorQuestions(launch, control, 'session-e');
    const result = ask({ question: 'May I start?' });
    const declined = await until(async () => {
      await questions.sync(null);
      return Promise.race([result, new Promise<undefined>(resolve => setTimeout(resolve, 20))]);
    });
    assert.equal(declined.isError, true);
    assert.match(declined.content[0].text, /accepted once the goal is running/);
    assert.equal(control.reports.length, 0);
  });

  test('the maximum wait returns a clear no-answer result and closes the blocker', async () => {
    const launch = await createOperatorQuestionExchange(60_000, root);
    const { ask } = startServer(launch);
    const control = recordingControl();
    let now = 1_000;
    const questions = new ClaudeOperatorQuestions(launch, control, 'session-f', () => now);
    const result = ask({ question: 'Ship on Friday?' });
    const report = await reported(questions, control);
    now += 59_999;
    await questions.sync('turn-1');
    assert.equal(questions.waiting, 1);
    now += 1;
    await questions.sync('turn-1');
    assert.equal(questions.waiting, 0);
    const timedOut = await result;
    assert.equal(timedOut.isError, undefined);
    assert.match(timedOut.content[0].text, /^No answer from the operator within 1 minute\. Continue with a clearly stated assumption, or stop/);
    assert.deepEqual(control.resolved, [{ requestKey: report.requestKey, resolution: 'question_timed_out' }]);
    // A late input after the timeout is an ordinary correction.
    assert.equal(await questions.answer({ id: 'late', message: 'Yes', sequence: 9 }, 'turn-1'), false);
  });

  test('a question opened partway through an attempt gets its no-answer result before the attempt is killed', async () => {
    const hour = 3_600_000;
    const start = 10_000_000;
    // Default 24-hour setting, already capped by a one-hour agent timeout.
    const created = await createOperatorQuestionExchange(boundGoalQuestionMaxWaitMs(86_400_000, hour), root);
    const launch = boundOperatorQuestionLaunch(created, start + hour, hour, start);
    const killAt = start + hour;
    assert.equal(launch.closeAt, killAt - 5 * 60_000);
    const { ask } = startServer(launch);
    const control = recordingControl();
    let now = start + 10 * 60_000;
    const questions = new ClaudeOperatorQuestions(launch, control, 'session-mid', () => now);
    const result = ask({ question: 'Which region?' });
    const report = await reported(questions, control);
    now = launch.closeAt! - 1;
    await questions.sync('turn-1');
    assert.equal(questions.waiting, 1);
    now = launch.closeAt!;
    await questions.sync('turn-1');
    assert.equal(questions.waiting, 0);
    assert.ok(now < killAt);
    const timedOut = await result;
    assert.equal(timedOut.isError, undefined);
    assert.match(timedOut.content[0].text, /^No answer from the operator before this goal attempt runs out of time\. Continue with a clearly stated assumption, or stop/);
    assert.deepEqual(control.resolved, [{ requestKey: report.requestKey, resolution: 'question_timed_out' }]);
  });

  test('a question asked with too little attempt time left is answered at once without a blocker', async () => {
    const created = await createOperatorQuestionExchange(86_400_000, root);
    const launch = boundOperatorQuestionLaunch(created, 3_600_000, 3_600_000, 0);
    const { ask } = startServer(launch);
    const control = recordingControl();
    const questions = new ClaudeOperatorQuestions(launch, control, 'session-late', () => launch.closeAt! - 59_999);
    const result = ask({ question: 'Last call?' });
    const declined = await until(async () => {
      await questions.sync('turn-1');
      return Promise.race([result, new Promise<undefined>(resolve => setTimeout(resolve, 20))]);
    });
    assert.equal(declined.isError, undefined);
    assert.match(declined.content[0].text, /^Too little time is left in this goal attempt/);
    assert.equal(control.reports.length, 0);
    assert.equal(questions.waiting, 0);
  });

  test('the server declines on its own when the attempt close time is near', async () => {
    const launch = await createOperatorQuestionExchange(60_000, root);
    const { ask } = startServer(launch, { PROPR_OPERATOR_CLOSE_AT: String(Date.now() + 30_000) });
    const result = await ask({ question: 'Anyone?' });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /^Too little time is left in this goal attempt/);
    assert.equal(existsSync(path.join(launch.exchangeDir, 'requests')) && readdirSync(path.join(launch.exchangeDir, 'requests')).length, 0);
  });

  test('the server stops waiting on its own when no worker answers', async () => {
    const launch = await createOperatorQuestionExchange(60_000, root);
    const { ask } = startServer(launch, { PROPR_OPERATOR_MAX_WAIT_MS: '150', PROPR_OPERATOR_GRACE_MS: '0' });
    const result = await ask({ question: 'Anyone?' });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /^No answer from the operator/);
  });

  test('attempt end closes open questions and the exchange is removed', async () => {
    const launch = await createOperatorQuestionExchange(60_000, root);
    const { ask } = startServer(launch);
    const control = recordingControl();
    const questions = new ClaudeOperatorQuestions(launch, control, 'session-g');
    const result = ask({ question: 'Keep going?' });
    const report = await reported(questions, control);
    await questions.closeOpen('attempt_ended', 'the goal attempt ended');
    const closed = await result;
    assert.equal(closed.isError, true);
    assert.match(closed.content[0].text, /the goal attempt ended/);
    assert.deepEqual(control.resolved, [{ requestKey: report.requestKey, resolution: 'attempt_ended' }]);
    await removeOperatorQuestionExchange(launch);
    assert.equal(existsSync(launch.exchangeDir), false);
  });

  test('unreadable request files are closed rather than reported', async () => {
    const launch = await createOperatorQuestionExchange(60_000, root);
    const id = '00000000-0000-4000-8000-000000000000';
    writeFileSync(path.join(launch.exchangeDir, 'requests', `${id}.json`), '{"id":"someone-else","question":"x"}');
    writeFileSync(path.join(launch.exchangeDir, 'requests', 'not-a-request.json'), '{}');
    const control = recordingControl();
    await new ClaudeOperatorQuestions(launch, control, 'session-h').sync('turn-1');
    assert.equal(control.reports.length, 0);
    const response = JSON.parse(readFileSync(path.join(launch.exchangeDir, 'responses', `${id}.json`), 'utf8'));
    assert.equal(response.status, 'closed');
  });

  test('the exchange is unlistable to others but lets the container user write requests', async () => {
    const launch = await createOperatorQuestionExchange(60_000, root);
    assert.equal(statSync(launch.exchangeDir).mode & 0o777, 0o711);
    assert.equal(statSync(path.join(launch.exchangeDir, 'requests')).mode & 0o777, 0o733);
    assert.equal(statSync(path.join(launch.exchangeDir, 'responses')).mode & 0o777, 0o711);
  });
});

describe('ask_operator launch wiring', () => {
  const config = {
    id: 'claude-1', alias: 'claude', type: 'claude', dockerImage: 'propr/runtime-agent:test',
    configPath: root, supportedModels: ['claude-opus-5'], defaultModel: 'claude-opus-5',
  } as unknown as AgentConfig;
  const launch: OperatorQuestionLaunch = { exchangeDir: `${OPERATOR_QUESTION_EXCHANGE_ROOT}/attempt-1`, maxWaitMs: 86_400_000 };
  const base = { worktreePath: '/tmp/worktree', githubToken: 'token', modelName: 'claude-opus-5', issueNumber: 7 };

  /** Container names carry a random execution id; everything else must match exactly. */
  const stable = (args: string[]) => args.map((arg, index) => args[index - 1] === '--name' ? '<name>' : arg);

  test('task-mode launch arguments are unchanged and never carry the tool', () => {
    const plain = stable(buildDockerArgs(config, 1000, { ...base, executionMode: 'task' }));
    const offered = stable(buildDockerArgs(config, 1000, { ...base, executionMode: 'task', operatorQuestions: launch }));
    assert.deepEqual(offered, plain);
    assert.doesNotMatch(offered.join(' '), /propr_operator|ask_operator|--mcp-config/);
    const defaultMode = stable(buildDockerArgs(config, 1000, { ...base, operatorQuestions: launch }));
    assert.deepEqual(defaultMode, plain);
  });

  test('goal sessions get one inline stdio server with a tool timeout beyond the wait', () => {
    const args = buildDockerArgs(config, 1000, { ...base, executionMode: 'goal', sessionId: 'session-new', operatorQuestions: launch });
    const index = args.indexOf('--mcp-config');
    assert.ok(index > 0);
    const parsed = JSON.parse(args[index + 1]) as { mcpServers: Record<string, Record<string, any>> }; // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.deepEqual(Object.keys(parsed.mcpServers), [OPERATOR_QUESTION_SERVER_NAME]);
    const server = parsed.mcpServers[OPERATOR_QUESTION_SERVER_NAME];
    assert.equal(server.type, 'stdio');
    assert.equal(server.command, 'node');
    assert.equal(server.env.PROPR_OPERATOR_EXCHANGE_DIR, launch.exchangeDir);
    assert.equal(server.env.PROPR_OPERATOR_MAX_WAIT_MS, '86400000');
    assert.ok(server.timeout > 86_400_000);
    assert.equal(server.timeout, operatorQuestionToolTimeoutMs(86_400_000));
    // No new credentials and no network endpoint reach the container through the tool.
    assert.deepEqual(Object.keys(server.env).sort(), [
      'PROPR_OPERATOR_EXCHANGE_DIR', 'PROPR_OPERATOR_GRACE_MS', 'PROPR_OPERATOR_MAX_WAIT_MS',
      'PROPR_OPERATOR_TOOL_DESCRIPTION', 'PROPR_OPERATOR_WAIT_LABEL',
    ]);
    assert.doesNotMatch(JSON.stringify(server), /https?:\/\/|GH_TOKEN|token=/);
    // Goal mode does not restrict the session to the injected server.
    assert.equal(args.includes('--strict-mcp-config'), false);
    const withoutTool = buildDockerArgs(config, 1000, { ...base, executionMode: 'goal', sessionId: 'session-new' });
    assert.equal(withoutTool.includes('--mcp-config'), false);
  });

  test('the exchange must live in the shared log directory', () => {
    assert.throws(() => buildOperatorQuestionMcpConfig({ exchangeDir: '/home/node/elsewhere', maxWaitMs: 60_000 }), /shared Claude log directory/);
  });

  test('the attempt bound caps the wait and reaches the server env', () => {
    const bound = boundOperatorQuestionLaunch(launch, 5_000_000 + 600_000, 600_000, 5_000_000);
    // A ten-minute attempt keeps a tenth of it in reserve.
    assert.equal(bound.closeAt, 5_000_000 + 540_000);
    assert.equal(bound.maxWaitMs, 540_000);
    assert.equal(launch.closeAt, undefined);
    const env = JSON.parse(buildOperatorQuestionMcpConfig(bound)).mcpServers[OPERATOR_QUESTION_SERVER_NAME].env;
    assert.equal(env.PROPR_OPERATOR_CLOSE_AT, String(bound.closeAt));
    assert.equal(env.PROPR_OPERATOR_MAX_WAIT_MS, '540000');
    assert.equal(JSON.parse(buildOperatorQuestionMcpConfig(launch)).mcpServers[OPERATOR_QUESTION_SERVER_NAME].env.PROPR_OPERATOR_CLOSE_AT, undefined);
  });

  test('the maximum wait instance setting is validated on save', async () => {
    const { extractSettingSaves } = await import('../packages/api/routes/configSettings.ts');
    const saved = await extractSettingSaves({ goal_question_max_wait_ms: 3_600_000 });
    assert.equal(saved.error, undefined);
    assert.equal(saved.normalized.goal_question_max_wait_ms, 3_600_000);
    assert.deepEqual(saved.saves, [{ name: 'goal_question_max_wait_ms' }]);
    for (const value of [59_999, 0, 90_000.5, 'a day', null]) {
      assert.match((await extractSettingSaves({ goal_question_max_wait_ms: value })).error ?? '', /goal_question_max_wait_ms must be an integer of at least 60000/, String(value));
    }
  });

  test('the maximum wait is bounded by the agent deadline', () => {
    assert.equal(boundGoalQuestionMaxWaitMs(86_400_000, 3_600_000), 3_600_000);
    assert.equal(boundGoalQuestionMaxWaitMs(600_000, 3_600_000), 600_000);
  });

  test('question support is projected for Claude and Codex only', () => {
    assert.equal(goalProviderAnswersQuestions('claude'), true);
    assert.equal(goalProviderAnswersQuestions('codex'), true);
    assert.equal(goalProviderAnswersQuestions('antigravity'), false);
    assert.equal(goalProviderAnswersQuestions(null), false);
    assert.match(goalBlockerSupport('claude').notes, /ask_operator/);
  });
});
