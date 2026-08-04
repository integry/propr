import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, afterEach, describe, test } from 'node:test';
import type { AgentConfig } from '@propr/core';
import { closeConnection, shutdownQueue } from '@propr/core';
import {
  isAgentLoginComplete,
  prepareAgentLoginCredentialDefaults,
} from '../services/agentLoginDocker.js';
import { AgentLoginSessionManager } from '../services/agentLoginSessionManager.js';

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'codex-1',
    type: 'codex',
    alias: 'codex',
    enabled: true,
    dockerImage: 'propr/agent:test',
    configPath: '/tmp/propr-test-codex',
    supportedModels: ['gpt-test'],
    ...overrides,
  };
}

function fakeChild(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  });
  return child;
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

const managers: AgentLoginSessionManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.close()));
});

after(async () => {
  await closeConnection();
  await shutdownQueue();
});

describe('Antigravity agent login', () => {
  test('preconfigures privacy and non-interactive workspace defaults', () => {
    const credentialPath = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-antigravity-defaults-'));
    const settingsPath = path.join(credentialPath, 'antigravity-cli', 'settings.json');
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify({
        enableTelemetry: true,
        colorScheme: 'solarized',
        trustedWorkspaces: ['/existing/workspace'],
        unrelated: 'preserved',
      }));

      prepareAgentLoginCredentialDefaults('antigravity', credentialPath);

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
      assert.equal(settings.enableTelemetry, false);
      assert.equal(settings.colorScheme, 'solarized');
      assert.deepEqual(settings.trustedWorkspaces, ['/existing/workspace', '/home/node/workspace']);
      assert.equal(settings.unrelated, 'preserved');
    } finally {
      fs.rmSync(credentialPath, { recursive: true, force: true });
    }
  });

  test('recognizes completed authentication only after onboarding is saved', () => {
    const credentialPath = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-antigravity-complete-'));
    const tokenPath = path.join(credentialPath, 'antigravity-cli', 'antigravity-oauth-token');
    const onboardingPath = path.join(credentialPath, 'antigravity-cli', 'cache', 'onboarding.json');
    try {
      fs.mkdirSync(path.dirname(onboardingPath), { recursive: true });
      fs.writeFileSync(tokenPath, 'token');
      fs.writeFileSync(onboardingPath, JSON.stringify({ onboardingComplete: false }));
      assert.equal(isAgentLoginComplete('antigravity', credentialPath), false);

      fs.writeFileSync(onboardingPath, JSON.stringify({ onboardingComplete: true }));
      assert.equal(isAgentLoginComplete('antigravity', credentialPath), true);
    } finally {
      fs.rmSync(credentialPath, { recursive: true, force: true });
    }
  });

  test('finishes login after credentials and onboarding are persisted', async () => {
    const credentialPath = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-antigravity-login-'));
    const child = fakeChild();
    const dockerCalls: string[][] = [];
    const manager = new AgentLoginSessionManager({
      id: () => 'antigravity-session',
      runDocker: async args => {
        dockerCalls.push(args);
        return { stdout: '', stderr: '' };
      },
      spawnDocker: args => {
        dockerCalls.push(args);
        return child;
      },
      providerCompletionPollMs: 5,
      sessionTimeoutMs: 60_000,
      sessionRetentionMs: 60_000,
    });
    managers.push(manager);

    try {
      const started = await manager.start(agent({
        id: 'antigravity-1',
        type: 'antigravity',
        alias: 'antigravity',
        configPath: credentialPath,
      }), 'owner');
      assert.equal(started.status, 'running');

      const cliPath = path.join(credentialPath, 'antigravity-cli');
      fs.mkdirSync(path.join(cliPath, 'cache'), { recursive: true });
      fs.writeFileSync(path.join(cliPath, 'antigravity-oauth-token'), 'token');
      fs.writeFileSync(
        path.join(cliPath, 'cache', 'onboarding.json'),
        JSON.stringify({ onboardingComplete: true }),
      );

      await waitFor(() => manager.get(started.id, 'owner').status === 'succeeded');
      const completed = manager.get(started.id, 'owner');
      assert.match(completed.output, /Authentication saved/);
      assert.equal(completed.exitCode, 0);
      assert.ok(dockerCalls.some(args => args[0] === 'rm' && args[1] === '-f'));
    } finally {
      fs.rmSync(credentialPath, { recursive: true, force: true });
    }
  });

  test('returns success without a container when already authenticated', async () => {
    const credentialPath = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-antigravity-existing-'));
    const cliPath = path.join(credentialPath, 'antigravity-cli');
    const dockerCalls: string[][] = [];
    const manager = new AgentLoginSessionManager({
      id: () => 'antigravity-existing-session',
      runDocker: async args => {
        dockerCalls.push(args);
        return { stdout: '', stderr: '' };
      },
      spawnDocker: () => fakeChild(),
      sessionTimeoutMs: 60_000,
      sessionRetentionMs: 60_000,
    });
    managers.push(manager);

    try {
      fs.mkdirSync(path.join(cliPath, 'cache'), { recursive: true });
      fs.writeFileSync(path.join(cliPath, 'antigravity-oauth-token'), 'token');
      fs.writeFileSync(
        path.join(cliPath, 'cache', 'onboarding.json'),
        JSON.stringify({ onboardingComplete: true }),
      );

      const started = await manager.start(agent({
        id: 'antigravity-existing',
        type: 'antigravity',
        alias: 'antigravity',
        configPath: credentialPath,
      }), 'owner');

      assert.equal(started.status, 'succeeded');
      assert.equal(started.exitCode, 0);
      assert.match(started.output, /already available/);
      assert.deepEqual(dockerCalls, []);
    } finally {
      fs.rmSync(credentialPath, { recursive: true, force: true });
    }
  });
});
