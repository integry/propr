import { after, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Every goal's Pi sessions go to a scratch store for this suite.
const sessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-pi-goal-sessions-'));
process.env.PI_GOAL_SESSIONS_PATH = sessionsRoot;

const FIXTURE = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/pi/pi-1.6.1-json-tool-task.jsonl'), 'utf8');
const FIXTURE_SESSION_ID = '01a21d71-9198-74eb-978e-565639986934';
const FIXTURE_SUMMARY = 'Done. Added subtract(a, b) to math.js, exported it, and added a test; node --test passes.';
const PI_HELP = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../packages/core/test/fixtures/pi-help-1.6.1.txt'), 'utf8');

interface PiRun { args: string[]; stdin?: string; extraEnvVars?: Record<string, string> }
const piRuns: PiRun[] = [];
const sudoCalls: string[][] = [];
/** What the stand-in Pi answers; receives the prompts the session holds after this run. */
let replyFor: (prompts: string[]) => string = prompts => `seen ${prompts.length} prompts`;
/** Where in the stream the stand-in Pi is stopped, if anywhere. */
let stopAfterHeader = false;

const realDockerExecutor = await import('../packages/core/src/claude/docker/dockerExecutor.js');
const { inspectSessionMessageLine } = await import('../packages/core/src/claude/docker/dockerSessionOutput.js');

function valueAfter(args: string[], flag: string): string | undefined {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
}

/**
 * A stand-in for `pi -p --mode json` with a persisted session directory: it
 * opens the session the arguments name (as Pi 1.6.1 does), appends the prompt,
 * and streams the recorded trace under that session's identity. Session
 * detection runs through the executor's real line inspection.
 */
async function fakePiRun(args: string[], options: Parameters<typeof realDockerExecutor.executeDockerCommand>[2] = {}) {
    piRuns.push({ args, stdin: options.stdinData, extraEnvVars: options.extraEnvVars });
    const mount = args.find(arg => arg.endsWith(':/home/node/.propr-pi-goal-session:rw'));
    assert.ok(mount, 'the goal session store is mounted');
    const hostDir = mount.slice(0, -':/home/node/.propr-pi-goal-session:rw'.length);
    assert.equal(valueAfter(args, '--session-dir'), '/home/node/.propr-pi-goal-session');
    const resumePath = valueAfter(args, '--session');
    let sessionId = valueAfter(args, '--session-id');
    let file: string;
    let prompts: string[] = [];
    if (resumePath) {
        file = path.join(hostDir, path.posix.basename(resumePath));
        const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        sessionId = lines[0].id;
        prompts = lines.filter(line => line.type === 'prompt').map(line => line.text);
    } else {
        assert.ok(sessionId);
        file = path.join(hostDir, `2026-11-27T00-00-00-000Z_${sessionId}.jsonl`);
    }
    const lines = FIXTURE.replaceAll(FIXTURE_SESSION_ID, sessionId!).trim().split('\n');
    const stdout: string[] = [];
    const state = { sessionIdDetected: false };
    const pending: Array<Promise<unknown>> = [];
    const context = {
        messageTimestamps: new Map<string, string>(), state, onSessionId: options.onSessionId, sessionIdFromLine: options.sessionIdFromLine,
        invokeExecutionCallback: (callback: () => void | Promise<void>) => { pending.push(Promise.resolve().then(callback)); },
    };
    for (const line of lines) {
        const record = JSON.parse(line);
        if (record.type === 'message_end' && record.message?.role === 'user') {
            // Pi writes the session file when the prompt is appended.
            prompts.push(options.stdinData ?? '');
            if (!fs.existsSync(file)) fs.writeFileSync(file, `${JSON.stringify({ type: 'session', version: 3, id: sessionId })}\n`);
            fs.appendFileSync(file, `${JSON.stringify({ type: 'prompt', text: options.stdinData })}\n`);
        }
        const emitted = line.replace(JSON.stringify(FIXTURE_SUMMARY).slice(1, -1), JSON.stringify(replyFor(prompts)).slice(1, -1));
        stdout.push(emitted);
        inspectSessionMessageLine(emitted, new Date().toISOString(), context);
        if (stopAfterHeader && record.type === 'session') break;
    }
    await Promise.all(pending);
    return { stdout: `${stdout.join('\n')}\n`, stderr: '', exitCode: stopAfterHeader ? 137 : 0, timedOut: false, messageTimestamps: new Map() };
}

await mock.module('../packages/core/src/claude/docker/dockerExecutor.js', { namedExports: {
    ...realDockerExecutor,
    executeDockerCommand: async (command: string, args: string[], options?: Parameters<typeof realDockerExecutor.executeDockerCommand>[2]) => {
        if (command === 'sudo') {
            sudoCalls.push(args);
            return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
        }
        return fakePiRun(args, options);
    },
} });

const { PiAgent } = await import('../packages/core/src/agents/impl/PiAgent.js');
const { probeGoalCapability, piHelpSupportsWholeSession } = await import('../packages/core/src/agents/goalCapabilities.js');
const { buildPiDockerArgs, PI_CONTAINER_SESSION_DIR } = await import('../packages/core/src/agents/impl/utils/piDockerArgsBuilder.js');
const {
    PI_CONTAINER_GOAL_SESSION_DIR, createPiSessionSavedDetector, findPiGoalSessionFile, piGoalSessionCliArgs, piGoalSessionDir,
    preparePiGoalSession, removePiGoalSessions,
} = await import('../packages/core/src/agents/impl/utils/piGoalSession.js');
const { parseGoalCheckpointDeclaration } = await import('../packages/core/src/goals.js');
const { closeConnection } = await import('../packages/core/src/db/connection.js');
type Agent = import('../packages/core/src/agents/types.js').Agent;
type AgentConfig = import('../packages/core/src/agents/types.js').AgentConfig;
type AgentTaskOptions = import('../packages/core/src/agents/types.js').AgentTaskOptions;
type AgentExecutionResult = import('../packages/core/src/agents/types.js').AgentExecutionResult;

const MODEL = 'pi-openrouter/mistralai/devstral-2512';
const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-pi-goal-worktree-'));
fs.mkdirSync(path.join(worktreePath, '.git'));

after(async () => {
    fs.rmSync(sessionsRoot, { recursive: true, force: true });
    fs.rmSync(worktreePath, { recursive: true, force: true });
    await closeConnection();
});

function piConfig(): AgentConfig {
    return {
        id: 'pi-test', type: 'pi', alias: 'pi-test', enabled: true, dockerImage: 'propr/agent:latest',
        configPath: '/nonexistent/propr-pi-test/agent', supportedModels: [MODEL], defaultModel: MODEL,
    };
}

function createAgent() {
    const agent = new PiAgent(piConfig());
    (agent as unknown as { persistTaskLog: () => Promise<void> }).persistTaskLog = async () => {};
    return agent;
}

function goalOptions(overrides: Partial<AgentTaskOptions> = {}): AgentTaskOptions {
    return {
        worktreePath, issueRef: { repoOwner: 'integry', repoName: 'propr', number: 0 }, prompt: '/goal add subtract(a, b)',
        model: MODEL, githubToken: 'gh-token', repositoryAccess: 'none', taskId: 'goal-task-1', executionMode: 'goal', goalId: 'goal-1',
        environment: { PROPR_EXECUTION_MODE: 'goal', PROPR_GOAL_LAUNCH_STRATEGY: 'direct' }, ...overrides,
    } as AgentTaskOptions;
}

const modeOf = (file: string) => fs.statSync(file).mode & 0o777;

describe('Pi goal capability', () => {
    test('the pinned Pi 1.6.1 help exposes every whole-session flag', () => {
        assert.equal(piHelpSupportsWholeSession(PI_HELP), true);
        for (const flag of ['--session-id', '--session-dir', '--session', '--mode']) {
            const help = PI_HELP.replace(new RegExp(`^\\s*${flag} .*$`, 'm'), '');
            assert.equal(piHelpSupportsWholeSession(help), false, `${flag} is required`);
        }
    });

    test('reports Pi as a goal-prompt, whole-session provider from offline help', async () => {
        const calls: string[][] = [];
        const capability = await probeGoalCapability(createAgent() as Agent, async (_command, args) => {
            calls.push(args);
            return { stdout: PI_HELP, stderr: '', exitCode: 0, messageTimestamps: new Map() };
        });
        assert.equal(capability.goalCapable, true, capability.reason);
        assert.deepEqual(capability.lifecycle, { launch: 'goal-prompt', resume: 'whole-session', runningInput: 'safe-boundary-resume' });
        assert.deepEqual(capability.controls, { liveInput: false, inputAtBoundary: true, modelAtBoundary: true, pauseAtBoundary: true, operatorQuestions: false });
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].slice(calls[0].indexOf('--network'), calls[0].indexOf('--network') + 2), ['--network', 'none']);
        assert.equal(calls[0].includes('-v'), false, 'introspection must not read mounted credentials');
        assert.equal(calls[0].at(-1), 'pi --help');
    });

    test('a Pi runtime without exact session resume is not goal capable', async () => {
        const capability = await probeGoalCapability(createAgent() as Agent, async () => ({
            stdout: PI_HELP.replace(/^\s*--session-id .*$/m, ''), stderr: '', exitCode: 0, messageTimestamps: new Map(),
        }));
        assert.equal(capability.goalCapable, false);
        assert.match(capability.reason ?? '', /--session-id/);
    });
});

describe('Pi goal session store', () => {
    test('a new goal gets an owner-only store and a ProPR-assigned session ID', () => {
        const session = preparePiGoalSession('goal-new');
        assert.equal(session.hostDir, path.join(sessionsRoot, 'goal-new'));
        assert.equal(modeOf(sessionsRoot), 0o700);
        assert.equal(modeOf(session.hostDir), 0o700);
        assert.match(session.sessionId, /^[0-9a-f-]{36}$/);
        assert.equal(session.resumeFile, undefined);
        assert.deepEqual(piGoalSessionCliArgs(session), ['--session-dir', PI_CONTAINER_GOAL_SESSION_DIR, '--session-id', session.sessionId]);
    });

    test('a resumed goal reopens the exact saved session file', () => {
        const hostDir = piGoalSessionDir('goal-resume');
        fs.mkdirSync(hostDir, { recursive: true });
        fs.writeFileSync(path.join(hostDir, '2026-11-27T10-00-00-000Z_session-a.jsonl'), '{}\n');
        fs.writeFileSync(path.join(hostDir, '2026-11-27T10-00-00-000Z_other-session-a.jsonl'), '{}\n');
        const session = preparePiGoalSession('goal-resume', 'session-a');
        assert.equal(session.resumeFile, '2026-11-27T10-00-00-000Z_session-a.jsonl');
        assert.deepEqual(piGoalSessionCliArgs(session), [
            '--session-dir', PI_CONTAINER_GOAL_SESSION_DIR, '--session', `${PI_CONTAINER_GOAL_SESSION_DIR}/2026-11-27T10-00-00-000Z_session-a.jsonl`,
        ]);
    });

    test('a resume whose session file is gone fails instead of starting an empty conversation', () => {
        assert.throws(() => preparePiGoalSession('goal-lost', 'session-gone'), /Pi goal session session-gone is missing/);
    });

    test('rejects identities that are not plain path segments', () => {
        assert.throws(() => preparePiGoalSession('../escape'), /Invalid goal ID/);
        assert.throws(() => preparePiGoalSession('goal-ok', '../../etc/passwd'), /Invalid session ID/);
    });

    test('deleting the goal removes its sessions', async () => {
        const session = preparePiGoalSession('goal-deleted');
        fs.writeFileSync(path.join(session.hostDir, `x_${session.sessionId}.jsonl`), '{}\n');
        await removePiGoalSessions('goal-deleted');
        assert.equal(fs.existsSync(session.hostDir), false);
        await removePiGoalSessions('goal-never-ran');
    });

    // pi-entrypoint.sh hands the store back to the worker after each run and
    // keeps the session files node's (UID 1000, mode 0600). A worker with any
    // other UID can then list and delete them but not read them: mode 000 files
    // stand in for node-owned ones, as this suite cannot run as two users.
    test('a worker whose UID is not node’s resumes and deletes a goal it cannot read the sessions of', async () => {
        const hostDir = piGoalSessionDir('goal-other-uid');
        fs.mkdirSync(hostDir, { recursive: true, mode: 0o700 });
        const saved = path.join(hostDir, '2026-11-28T10-00-00-000Z_session-u.jsonl');
        fs.writeFileSync(saved, '{}\n', { mode: 0o600 });
        fs.chmodSync(saved, 0o000);
        const chmod = mock.method(fs, 'chmodSync');
        try {
            const session = preparePiGoalSession('goal-other-uid', 'session-u');
            assert.equal(session.resumeFile, path.basename(saved));
            assert.equal(chmod.mock.calls.length, 0, 'an owner-only store is not chmodded again');
        } finally { chmod.mock.restore(); }
        await removePiGoalSessions('goal-other-uid');
        assert.equal(fs.existsSync(hostDir), false);
    });

    test('a store the worker does not own fails with a clear permission error', async () => {
        const hostDir = piGoalSessionDir('goal-foreign');
        fs.mkdirSync(hostDir, { recursive: true, mode: 0o700 });
        // Group/other bits left by a foreign owner: chmod as the worker is refused.
        fs.chmodSync(hostDir, 0o750);
        const chmod = mock.method(fs, 'chmodSync', () => { throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); });
        try {
            assert.throws(() => preparePiGoalSession('goal-foreign'), /Cannot prepare the Pi goal session store .*goal-foreign: permission denied .*owned by the user ProPR runs as/);
        } finally { chmod.mock.restore(); }
        // Listing a store the worker cannot read.
        fs.chmodSync(hostDir, 0o300);
        try {
            if (process.getuid?.() !== 0) assert.throws(() => findPiGoalSessionFile(hostDir, 'session-x'), /Cannot list the Pi goal session store/);
        } finally { fs.chmodSync(hostDir, 0o700); }
        const rm = mock.method(fs.promises, 'rm', async () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); });
        try {
            await assert.rejects(removePiGoalSessions('goal-foreign'), /Cannot delete the Pi goal session store .*goal-foreign: permission denied/);
        } finally { rm.mock.restore(); }
        await removePiGoalSessions('goal-foreign');
    });

    test('docker args mount the goal store instead of the disposable session dir and pass goal variables by name', () => {
        const session = preparePiGoalSession('goal-args');
        const invocation = buildPiDockerArgs({
            config: piConfig(), worktreePath: '/tmp/worktree', modelName: MODEL, issueNumber: 0, taskId: 'goal-task', goalSession: session,
            environment: { PROPR_GOAL_LAUNCH_STRATEGY: 'orchestrate', PROPR_PARENT_KEY: 'signing-key', HOME: '/root', 'BAD NAME': 'x' },
        }, 'gh-token');
        const args = invocation.args;
        assert.ok(args.includes(`${session.hostDir}:${PI_CONTAINER_GOAL_SESSION_DIR}:rw`));
        assert.ok(args.includes(`PROPR_PI_GOAL_SESSION_DIR=${PI_CONTAINER_GOAL_SESSION_DIR}`));
        assert.equal(args.includes(PI_CONTAINER_SESSION_DIR), false);
        assert.equal(valueAfter(args, '--session-id'), session.sessionId);
        assert.equal(invocation.secretEnv.PROPR_GOAL_LAUNCH_STRATEGY, 'orchestrate');
        assert.equal(invocation.secretEnv.PROPR_PARENT_KEY, 'signing-key');
        assert.equal(args.some(arg => arg.includes('signing-key')), false, 'values never reach argv');
        assert.equal(invocation.secretEnv.HOME, undefined, 'reserved names are not overridden');
        assert.equal(invocation.secretEnv['BAD NAME'], undefined);
        assert.throws(() => buildPiDockerArgs({ config: piConfig(), worktreePath: '/tmp/w', modelName: MODEL, issueNumber: 0, mode: 'analysis', goalSession: session }, ''), /execute mode/);
    });

    test('task runs keep the disposable session dir', () => {
        const { args } = buildPiDockerArgs({ config: piConfig(), worktreePath: '/tmp/worktree', modelName: MODEL, issueNumber: 1 }, 'gh-token');
        assert.equal(valueAfter(args, '--session-dir'), PI_CONTAINER_SESSION_DIR);
        assert.equal(args.some(arg => arg.includes(PI_CONTAINER_GOAL_SESSION_DIR)), false);
    });

    test('the session is reported once Pi has written the prompt, and only for the goal session', () => {
        const lines = FIXTURE.trim().split('\n');
        const detect = createPiSessionSavedDetector(FIXTURE_SESSION_ID);
        const reports = lines.map(line => detect(line)).filter(Boolean);
        assert.deepEqual(reports, [FIXTURE_SESSION_ID]);
        const header = lines.findIndex(line => JSON.parse(line).type === 'session');
        assert.equal(createPiSessionSavedDetector(FIXTURE_SESSION_ID)(lines[header]), undefined, 'the header alone is not a saved session');
        const other = createPiSessionSavedDetector('another-session');
        assert.deepEqual(lines.map(line => other(line)).filter(Boolean), []);
    });
});

describe('Pi goal runs', () => {
    beforeEach(() => {
        piRuns.length = 0;
        sudoCalls.length = 0;
        replyFor = prompts => `seen ${prompts.length} prompts`;
        stopAfterHeader = false;
    });

    test('a new goal saves its session as soon as the prompt is written and resumes it with --session', async () => {
        const agent = createAgent();
        const saved: string[] = [];
        const first = await agent.executeTask(goalOptions({ goalId: 'goal-resume-run', onSessionId: sessionId => { saved.push(sessionId); } }));
        assert.equal(first.success, true, first.error);
        assert.equal(saved.length, 1, 'the identity is saved once');
        const sessionId = saved[0];
        assert.equal(first.sessionId, sessionId);
        assert.equal(valueAfter(piRuns[0].args, '--session-id'), sessionId);
        assert.equal(valueAfter(piRuns[0].args, '--session'), undefined);
        assert.equal(piRuns[0].stdin, '/goal add subtract(a, b)', 'goal input is delivered verbatim');
        assert.equal(piRuns[0].extraEnvVars?.PROPR_GOAL_LAUNCH_STRATEGY, 'direct');
        assert.deepEqual(sudoCalls.at(-1), ['chown', 'root:root', path.join(worktreePath, '.git')], 'direct goals protect Git metadata');
        const hostDir = piGoalSessionDir('goal-resume-run');
        const file = findPiGoalSessionFile(hostDir, sessionId);
        assert.ok(file);

        const resumed = await agent.executeTask(goalOptions({
            goalId: 'goal-resume-run', resumeSessionId: sessionId, prompt: 'Use subtraction in the README too.',
            model: 'pi-openrouter/mistralai/devstral-medium', onSessionId: id => { saved.push(id); },
        }));
        assert.equal(resumed.success, true, resumed.error);
        assert.equal(valueAfter(piRuns[1].args, '--session'), `${PI_CONTAINER_GOAL_SESSION_DIR}/${file}`);
        assert.equal(valueAfter(piRuns[1].args, '--session-id'), undefined);
        assert.equal(valueAfter(piRuns[1].args, '--model'), 'openrouter/mistralai/devstral-medium', 'the boundary model applies to the resumed session');
        assert.equal(resumed.summary, 'seen 2 prompts', 'the resumed session keeps the earlier conversation');
        assert.deepEqual(saved, [sessionId, sessionId]);
    });

    test('a resume after a checkpoint carries the checkpoint feedback into the same session', async () => {
        const agent = createAgent();
        const declaration = { checkpointReady: true, message: 'feat(math): add subtract', include: ['math.js'], summary: 'Subtract is done.' };
        replyFor = () => JSON.stringify(declaration);
        let sessionId = '';
        const first = await agent.executeTask(goalOptions({ goalId: 'goal-checkpoint', onSessionId: id => { sessionId = id; } }));
        assert.equal(first.success, true, first.error);
        const parsed = parseGoalCheckpointDeclaration(first.summary);
        assert.ok(parsed && !('rejected' in parsed));
        assert.equal(parsed.message, 'feat(math): add subtract');

        replyFor = prompts => prompts.join(' | ');
        const feedback = 'ProPR accepted and published your checkpoint as commit abc123. Continue working toward the goal.';
        const resumed = await agent.executeTask(goalOptions({ goalId: 'goal-checkpoint', resumeSessionId: sessionId, prompt: feedback }));
        assert.equal(resumed.success, true, resumed.error);
        assert.equal(resumed.sessionId, sessionId);
        assert.equal(resumed.summary, `/goal add subtract(a, b) | ${feedback}`);
    });

    test('a run stopped before Pi wrote the prompt saves no session identity', async () => {
        stopAfterHeader = true;
        const saved: string[] = [];
        const result: AgentExecutionResult = await createAgent().executeTask(goalOptions({ goalId: 'goal-early-stop', onSessionId: id => { saved.push(id); } }));
        assert.equal(result.success, false);
        assert.deepEqual(saved, [], 'the next attempt starts a new session rather than resuming an empty one');
    });

    test('a goal whose saved session is gone fails without starting Pi', async () => {
        const result = await createAgent().executeTask(goalOptions({ goalId: 'goal-missing', resumeSessionId: 'lost-session' }));
        assert.equal(result.success, false);
        assert.match(result.error ?? '', /Pi goal session lost-session is missing/);
        assert.equal(piRuns.length, 0);
    });

    test('a goal run needs the goal identity', async () => {
        const result = await createAgent().executeTask(goalOptions({ goalId: undefined }));
        assert.equal(result.success, false);
        assert.match(result.error ?? '', /goal identity/);
        assert.equal(piRuns.length, 0);
    });
});
