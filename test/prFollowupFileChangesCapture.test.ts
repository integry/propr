import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.GH_APP_ID ||= '1';
process.env.GH_INSTALLATION_ID ||= '1';
const privateKeyPath = join(tmpdir(), 'propr-test-private-key.pem');
writeFileSync(privateKeyPath, '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n');
process.env.GH_PRIVATE_KEY_PATH ||= privateKeyPath;
process.env.DEFAULT_CLAUDE_MODEL ||= 'haiku';

const realNetworkEgress = await import('../src/jobs/networkEgress.js');
mock.module('../src/jobs/networkEgress.js', {
    namedExports: { ...realNetworkEgress, runWithNetworkPolicy: async (_options: unknown, execute: () => Promise<unknown>) => execute() },
});
mock.module('../src/jobs/repositoryValidationEvent.js', { namedExports: { recordRepositoryValidationEvent: async () => undefined } });
mock.module('../src/jobs/repositoryWorkflow.js', {
    namedExports: { runRepositoryWorkflow: async (_options: unknown, execute: () => Promise<unknown>) => execute() },
});
// The capture itself (Redis key, shape and overlap check) is covered in core; here, who starts and stops it.
const events: string[] = [];
const starts: Array<Record<string, unknown>> = [];
mock.module('../src/jobs/liveFileChangesCapture.js', {
    namedExports: {
        startTaskFileChangesCapture: async (options: Record<string, unknown>) => {
            starts.push({ taskId: options.taskId, worktreePath: options.worktreePath, repository: options.repository, redis: options.redis });
            events.push('start');
            return { stop: async ({ finalCapture = false } = {}) => { events.push(`stop:${finalCapture}`); } };
        },
    },
});

const { resolveAndExecuteAgent } = await import('../src/jobs/prCommentAgentUtils.js');
const { AgentRegistry, db } = await import('@propr/core');
after(() => db.destroy());

const logger = { debug: () => undefined, info: () => undefined, warn: () => undefined };
const redisClient = { name: 'worker-redis' };

function setup(t: { mock: { method: (...args: never[]) => unknown } }, executeTask: () => Promise<unknown>) {
    const registry = AgentRegistry.getInstance();
    const agent = { config: { alias: 'claude', type: 'claude', enabled: true, defaultModel: 'claude-test' }, executeTask };
    (t.mock.method as (object: object, name: string, impl: unknown) => void)(registry, 'ensureInitialized', async () => undefined);
    (t.mock.method as (object: object, name: string, impl: unknown) => void)(registry, 'getDefaultAgent', () => agent);
    (t.mock.method as (object: object, name: string, impl: unknown) => void)(registry, 'getAgentByAlias', () => agent);
}

const params = (overrides: Record<string, unknown> = {}) => ({
    llm: null, worktreePath: '/tmp/followup-worktree', branchName: 'feature', prompt: 'Fix it', pullRequestNumber: 41,
    repoOwner: 'acme', repoName: 'widget', taskId: 'followup-task', applyRepositoryWorkflow: true, captureFileChanges: true,
    stateManager: { updateTaskState: async () => undefined, getTaskState: async () => ({ state: 'processing' }) } as never,
    correlatedLogger: logger as never, githubToken: 'token', redisClient: redisClient as never,
    ...overrides,
});

test('PR follow-up and /fix runs capture live file changes around the agent, then once more after it exits', async t => {
    events.length = 0; starts.length = 0;
    setup(t, async () => { events.push('execute'); return { success: true, modelUsed: 'claude-test', executionTimeMs: 1, summary: 'done', conversationLog: [] }; });
    const { claudeResult } = await resolveAndExecuteAgent(params());
    assert.equal(claudeResult.success, true);
    assert.deepEqual(events, ['start', 'execute', 'stop:true']);
    assert.deepEqual(starts, [{ taskId: 'followup-task', worktreePath: '/tmp/followup-worktree', repository: 'acme/widget', redis: redisClient }]);
});

test('a failed follow-up stops the capture without a final scan', async t => {
    events.length = 0;
    setup(t, async () => { events.push('execute'); throw new Error('agent crashed'); });
    await assert.rejects(resolveAndExecuteAgent(params()), /agent crashed/);
    assert.deepEqual(events, ['start', 'execute', 'stop:false']);
});

test('helpers outside the follow-up workflow, or without the opt-in, do not capture', async t => {
    events.length = 0;
    setup(t, async () => { events.push('execute'); return { success: true, modelUsed: 'claude-test', executionTimeMs: 1, summary: 'done', conversationLog: [] }; });
    await resolveAndExecuteAgent(params({ applyRepositoryWorkflow: false }));
    await resolveAndExecuteAgent(params({ captureFileChanges: false }));
    assert.deepEqual(events, ['execute', 'execute']);
});
