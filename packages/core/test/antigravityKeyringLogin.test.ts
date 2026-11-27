import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';
import { ANTIGRAVITY_KEYRING_LOGIN_GUIDANCE } from '@propr/shared';
import { db } from '../src/db/connection.js';
import { inspectAntigravityCredentials, resolveAntigravityLoginFailure } from '../src/agents/impl/utils/antigravityCredentialCheck.js';

const previousContainerized = process.env.PROPR_CONTAINERIZED;
const previousConfigPath = process.env.ANTIGRAVITY_CONFIG_PATH;
process.env.PROPR_CONTAINERIZED = '0';
delete process.env.ANTIGRAVITY_CONFIG_PATH;

let dockerResult: { stdout: string; stderr: string; exitCode: number | null } = { stdout: '', stderr: '', exitCode: 0 };
const dockerExecutor = await import('../src/claude/docker/dockerExecutor.js');
await mock.module('../src/claude/docker/dockerExecutor.js', { namedExports: {
    ...dockerExecutor,
    executeDockerCommand: async () => dockerResult,
} });
const imagePresence = await import('../src/claude/docker/dockerImagePresence.js');
await mock.module('../src/claude/docker/dockerImagePresence.js', { namedExports: {
    ...imagePresence,
    agentDockerImageExists: async () => true,
} });
const { AntigravityAgent } = await import('../src/agents/impl/AntigravityAgent.js');

const homes: string[] = [];
after(async () => {
    mock.restoreAll();
    for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
    if (previousContainerized === undefined) delete process.env.PROPR_CONTAINERIZED;
    else process.env.PROPR_CONTAINERIZED = previousContainerized;
    if (previousConfigPath === undefined) delete process.env.ANTIGRAVITY_CONFIG_PATH;
    else process.env.ANTIGRAVITY_CONFIG_PATH = previousConfigPath;
    await db.destroy();
});

/** A fake host home with `~/.gemini`, optionally holding the file token and/or agy's keyring marker. */
function hostHome({ token = false, keyringMarker = false } = {}): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-agy-keyring-'));
    homes.push(home);
    const gemini = path.join(home, '.gemini');
    fs.mkdirSync(path.join(gemini, 'antigravity-cli'), { recursive: true });
    fs.writeFileSync(path.join(gemini, 'antigravity-cli', 'settings.json'), '{}');
    if (token) fs.writeFileSync(path.join(gemini, 'antigravity-cli', 'antigravity-oauth-token'), 'file-token');
    if (keyringMarker) {
        fs.mkdirSync(path.join(home, '.config', 'antigravity'), { recursive: true });
        fs.writeFileSync(path.join(home, '.config', 'antigravity', 'credential-user-scope'), 'user');
    }
    return gemini;
}

const model = 'antigravity-gemini-3.8-flash';
const agent = (configPath: string) => new AntigravityAgent({ id: 'keyring', alias: 'antigravity', type: 'antigravity', enabled: true,
    configPath, dockerImage: 'propr/agent:latest', supportedModels: [model], defaultModel: model });

type ProcessExecutionResult = (opts: Record<string, unknown>) => Promise<{ success: boolean; error?: string; logs: string }>;
function processResult(configPath: string, result: { stdout: string; stderr: string; exitCode: number | null }) {
    const instance = agent(configPath) as unknown as { processExecutionResult: ProcessExecutionResult };
    return instance.processExecutionResult.call(instance, {
        result, executionTime: 1, issueRef: { number: 7, repoOwner: 'o', repoName: 'r' }, effectiveModel: model,
        prompt: 'do the work', worktreePath: '/tmp/none', worktreeGitContent: null,
    });
}

// Output of the 1.5.15 agent image with a keyring-only ~/.gemini mounted.
const NO_AUTH_STDERR = [
    'Antigravity config directory mounted at /home/node/.gemini',
    'Warning: no obvious Antigravity authentication files found under /home/node/.gemini',
    'Ensure the Antigravity config directory is properly mounted and initialized',
    'Executing command: /bin/bash -lc set -e',
    "Error: authentication required. Run 'agy' to log in, then retry.",
    'error: authentication failed or timed out',
].join('\n');

test('a credential dir without the file token is not ready with the actionable reason', () => {
    const gemini = hostHome();
    const state = inspectAntigravityCredentials(gemini);
    assert.equal(state.status, 'missing');
    assert.equal(state.keyringMarkerDetected, false);
    assert.equal(state.reason, ANTIGRAVITY_KEYRING_LOGIN_GUIDANCE);
    assert.match(state.reason!, /OS keyring.*AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1 agy.*managed login/);
    assert.equal(agent(gemini).credentialProblem(), ANTIGRAVITY_KEYRING_LOGIN_GUIDANCE);
});

test('a credential dir with the file token is ready', async () => {
    const gemini = hostHome({ token: true, keyringMarker: true });
    assert.deepEqual(inspectAntigravityCredentials(gemini), { status: 'present', keyringMarkerDetected: false });
    assert.equal(agent(gemini).credentialProblem(), undefined);
    assert.equal(await agent(gemini).healthCheck(), true);
});

test('the boolean health check fails when only a keyring login exists', async () => {
    assert.equal(await agent(hostHome({ keyringMarker: true })).healthCheck(), false);
});

test('a visible host keyring marker is named explicitly; its contents are never needed', () => {
    const gemini = hostHome({ keyringMarker: true });
    const state = inspectAntigravityCredentials(gemini);
    assert.equal(state.status, 'missing');
    assert.equal(state.keyringMarkerDetected, true);
    assert.match(state.reason!, /^Found ~\/\.config\/antigravity\/credential-user-scope but no ~\/\.gemini\/antigravity-cli\/antigravity-oauth-token: agy saved this login in the OS keyring/);
    assert.match(state.reason!, /AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1 agy/);
});

test('a credential dir the worker cannot see is not reported as missing', () => {
    assert.deepEqual(inspectAntigravityCredentials(path.join(os.tmpdir(), 'propr-agy-absent', '.gemini')), { status: 'unknown', keyringMarkerDetected: false });
    assert.equal(agent(path.join(os.tmpdir(), 'propr-agy-absent', '.gemini')).credentialProblem(), undefined);
});

test('entrypoint and agy missing-login output maps to the actionable failure reason', () => {
    const gemini = hostHome();
    assert.equal(resolveAntigravityLoginFailure('Warning: no obvious Antigravity authentication files found under /home/node/.gemini', gemini), ANTIGRAVITY_KEYRING_LOGIN_GUIDANCE);
    assert.equal(resolveAntigravityLoginFailure("Error: authentication required. Run 'agy' to log in, then retry.", gemini), ANTIGRAVITY_KEYRING_LOGIN_GUIDANCE);
    assert.equal(resolveAntigravityLoginFailure('AGY_ERROR: {"short_error":"model API failure"}', gemini), undefined);
    assert.equal(resolveAntigravityLoginFailure('', gemini), undefined);
});

test('a failed task carries the actionable reason and keeps the raw CLI output in its logs', async () => {
    const result = await processResult(hostHome({ keyringMarker: true }), { stdout: '', stderr: NO_AUTH_STDERR, exitCode: 1 });
    assert.equal(result.success, false);
    assert.match(result.error!, /agy saved this login in the OS keyring.*AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1 agy/);
    assert.doesNotMatch(result.error!, /Run 'agy' to log in/);
    assert.match(result.logs, /Run 'agy' to log in, then retry\./);
    assert.match(result.logs, /no obvious Antigravity authentication files/);
});

test('unrelated task failures keep their own error', async () => {
    const result = await processResult(hostHome({ token: true }), { stdout: '', stderr: 'AGY_ERROR: {"short_error":"model API failure"}', exitCode: 3 });
    assert.match(result.error!, /model API failure/);
});

test('a failed analysis (and so the Settings health probe) carries the actionable reason', async () => {
    dockerResult = { stdout: '', stderr: NO_AUTH_STDERR, exitCode: 1 };
    const result = await agent(hostHome({ token: true })).analyze('Reply with only OK.', { model, suppressLlmLog: true, skipUsageTracking: true });
    assert.equal(result.success, false);
    assert.equal(result.error, `Analysis failed: ${ANTIGRAVITY_KEYRING_LOGIN_GUIDANCE}`);
});
