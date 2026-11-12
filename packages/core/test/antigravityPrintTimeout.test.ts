import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { db } from '../src/db/connection.js';
import { detectAntigravityPrintTimeout } from '../src/agents/impl/utils/antigravityPrintTimeout.js';

const previousContainerized = process.env.PROPR_CONTAINERIZED;
process.env.PROPR_CONTAINERIZED = '0';
after(() => {
    if (previousContainerized === undefined) delete process.env.PROPR_CONTAINERIZED;
    else process.env.PROPR_CONTAINERIZED = previousContainerized;
});

// Stderr shaped like Antigravity CLI 1.5.x when --print-timeout cuts a run short.
const PRINT_TIMEOUT_STDERR = [
    '[agy] print timeout after 3600s with 2 background task(s) still running; terminating them',
    'AGY_ERROR: {"short_error":"print timeout after 3600s while the agent was waiting on 2 background task(s); the response may be incomplete"}',
].join('\n');

let dockerResult: { stdout: string; stderr: string; exitCode: number | null } = { stdout: '', stderr: '', exitCode: 0 };
const dockerExecutor = await import('../src/claude/docker/dockerExecutor.js');
await mock.module('../src/claude/docker/dockerExecutor.js', { namedExports: {
    ...dockerExecutor,
    executeDockerCommand: async () => dockerResult,
} });
const { AntigravityAgent } = await import('../src/agents/impl/AntigravityAgent.js');
after(async () => { mock.restoreAll(); await db.destroy(); });

const model = 'antigravity-gemini-3.8-flash';
const agent = () => new AntigravityAgent({ id: 'timeout', alias: 'antigravity', type: 'antigravity', enabled: true,
    configPath: '~/.gemini', dockerImage: 'propr/agent:latest', supportedModels: [model], defaultModel: model });

type ProcessExecutionResult = (opts: Record<string, unknown>) => Promise<{ success: boolean; error?: string; terminationReason?: string; exitCode?: number | null }>;
function processResult(result: { stdout: string; stderr: string; exitCode: number | null }) {
    const instance = agent() as unknown as { processExecutionResult: ProcessExecutionResult };
    return instance.processExecutionResult.call(instance, {
        result, executionTime: 1, issueRef: { number: 7, repoOwner: 'o', repoName: 'r' }, effectiveModel: model,
        prompt: 'do the work', worktreePath: '/tmp/none', worktreeGitContent: null,
    });
}

test('detects the CLI 1.5 print timeout from the stderr notice and AGY_ERROR line', () => {
    const detected = detectAntigravityPrintTimeout(`ProPR agent stderr: ${PRINT_TIMEOUT_STDERR.split('\n').join('\nProPR agent stderr: ')}`, 3);
    assert.equal(detected?.duration, '3600s');
    assert.match(detected!.detail!, /waiting on 2 background task\(s\)/);
    assert.match(detected!.message, /--print-timeout after 3600s \(exit code 3\).*partial.*AGY_ERROR: print timeout after 3600s/);
    assert.ok(detectAntigravityPrintTimeout('AGY_ERROR: {"short_error":"print timeout after 90s with the turn still in progress; the response is partial"}', 3));
    assert.equal(detectAntigravityPrintTimeout('AGY_ERROR: {"short_error":"quota exhausted"}', 3), undefined);
    assert.equal(detectAntigravityPrintTimeout('', 3), undefined);
});

test('a task run that exits 3 on a print timeout fails as a timeout with the CLI explanation', async () => {
    const result = await processResult({ stdout: 'Partial answer so far', stderr: PRINT_TIMEOUT_STDERR, exitCode: 3 });
    assert.equal(result.success, false);
    assert.equal(result.exitCode, 3);
    assert.equal(result.terminationReason, 'timeout');
    assert.match(result.error!, /^Antigravity CLI hit its --print-timeout after 3600s \(exit code 3\)/);
    assert.match(result.error!, /AGY_ERROR: print timeout after 3600s while the agent was waiting on 2 background task\(s\)/);
    assert.match(result.error!, /ANTIGRAVITY_TIMEOUT_MS/);
});

test('other exit-3 AGY_ERROR failures keep their own error and no timeout reason', async () => {
    const result = await processResult({ stdout: '', stderr: 'AGY_ERROR: {"short_error":"model API failure"}', exitCode: 3 });
    assert.equal(result.success, false);
    assert.equal(result.terminationReason, undefined);
    assert.match(result.error!, /model API failure/);
});

test('analysis rejects the partial answer of a print-timed-out run', async () => {
    dockerResult = { stdout: 'half an answer', stderr: PRINT_TIMEOUT_STDERR, exitCode: 3 };
    const result = await agent().analyze('summarise', { model, suppressLlmLog: true });
    assert.equal(result.success, false);
    assert.match(result.error!, /^Analysis failed: Antigravity CLI hit its --print-timeout after 3600s/);
});
