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

function antigravityCredential(token: string): string {
  return JSON.stringify({
    access_token: token,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
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
  test('prepares login defaults inside the container after ownership normalization', () => {
    const entrypoint = fs.readFileSync(
      new URL('../../../scripts/antigravity-entrypoint.sh', import.meta.url),
      'utf8',
    );
    const ownershipRepair = entrypoint.indexOf('prepare_antigravity_config_dir "$antigravity_config_dir"');
    const loginDefaults = entrypoint.indexOf('prepare_antigravity_login_defaults "$antigravity_config_dir"');
    const dropPrivileges = entrypoint.indexOf('exec su-exec node env HOME=/home/node');

    assert.ok(ownershipRepair >= 0);
    assert.ok(loginDefaults > ownershipRepair);
    assert.ok(dropPrivileges > loginDefaults);
    assert.match(entrypoint, /settings\.enableTelemetry = false/);
    assert.match(entrypoint, /trustedWorkspaces\.push\('\/home\/node\/workspace'\)/);
    assert.match(entrypoint, /fs\.renameSync\(settingsPath, backupPath\)/);
    assert.match(entrypoint, /invalid Antigravity settings were backed up/);
  });

  test('recognizes only known, non-empty, unexpired authentication after onboarding is saved', async () => {
    const credentialPath = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-antigravity-complete-'));
    const tokenPath = path.join(credentialPath, 'antigravity-cli', 'antigravity-oauth-token');
    const onboardingPath = path.join(credentialPath, 'antigravity-cli', 'cache', 'onboarding.json');
    try {
      fs.mkdirSync(path.dirname(onboardingPath), { recursive: true });
      fs.writeFileSync(tokenPath, 'token');
      fs.writeFileSync(onboardingPath, JSON.stringify({ onboardingComplete: false }));
      assert.equal(await isAgentLoginComplete('antigravity', credentialPath), false);

      fs.writeFileSync(onboardingPath, JSON.stringify({ onboardingComplete: true }));
      assert.equal(await isAgentLoginComplete('antigravity', credentialPath), false);

      fs.writeFileSync(tokenPath, antigravityCredential('complete-token'));
      assert.equal(await isAgentLoginComplete('antigravity', credentialPath), true);

      fs.writeFileSync(tokenPath, '');
      assert.equal(await isAgentLoginComplete('antigravity', credentialPath), false);

      fs.writeFileSync(tokenPath, '{malformed');
      assert.equal(await isAgentLoginComplete('antigravity', credentialPath), false);

      fs.writeFileSync(tokenPath, JSON.stringify({ access_token: 'expired', expires_at: '2000-01-01T00:00:00.000Z' }));
      assert.equal(await isAgentLoginComplete('antigravity', credentialPath), false);

      fs.writeFileSync(tokenPath, JSON.stringify({
        access_token: 'expired',
        refresh_token: 'still-usable',
        expires_at: '2000-01-01T00:00:00.000Z',
      }));
      assert.equal(await isAgentLoginComplete('antigravity', credentialPath), true);

      fs.writeFileSync(tokenPath, JSON.stringify({
        access_token: 'expired',
        refresh_token: 'also-expired',
        expires_at: '2000-01-01T00:00:00.000Z',
        refresh_token_expires_at: '2000-01-01T00:00:00.000Z',
      }));
      assert.equal(await isAgentLoginComplete('antigravity', credentialPath), false);

      fs.writeFileSync(tokenPath, JSON.stringify({ expires_at: '2099-01-01T00:00:00.000Z', message: 'authenticated' }));
      assert.equal(await isAgentLoginComplete('antigravity', credentialPath), false);

      fs.writeFileSync(tokenPath, JSON.stringify({
        credentials: {
          access_token: 'nested-expired-token',
          expires_at: '2000-01-01T00:00:00.000Z',
        },
      }));
      assert.equal(await isAgentLoginComplete('antigravity', credentialPath), false);

      fs.writeFileSync(tokenPath, JSON.stringify({
        credentials: {
          access_token: 'nested-token',
          expires_at: String(Math.floor(Date.now() / 1000) + 3600),
        },
      }));
      assert.equal(await isAgentLoginComplete('antigravity', credentialPath), true);

      fs.truncateSync(tokenPath, 1024 * 1024 + 1);
      assert.equal(await isAgentLoginComplete('antigravity', credentialPath), false);
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
      providerCompletionPollMs: 20,
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
      fs.writeFileSync(path.join(cliPath, 'antigravity-oauth-token'), antigravityCredential('saved-token'));
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

  test('revalidates existing authentication through an explicit provider login', async () => {
    const credentialPath = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-antigravity-existing-'));
    const cliPath = path.join(credentialPath, 'antigravity-cli');
    const dockerCalls: string[][] = [];
    const manager = new AgentLoginSessionManager({
      id: () => 'antigravity-existing-session',
      runDocker: async args => {
        dockerCalls.push(args);
        return { stdout: '', stderr: '' };
      },
      spawnDocker: args => {
        dockerCalls.push(args);
        return fakeChild();
      },
      providerCompletionPollMs: 20,
      sessionTimeoutMs: 60_000,
      sessionRetentionMs: 60_000,
    });
    managers.push(manager);

    try {
      fs.mkdirSync(path.join(cliPath, 'cache'), { recursive: true });
      fs.writeFileSync(path.join(cliPath, 'antigravity-oauth-token'), antigravityCredential('existing-token'));
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

      assert.equal(started.status, 'running');
      assert.match(started.output, /will be revalidated/);
      assert.deepEqual(dockerCalls[0], ['image', 'inspect', 'propr/agent:test']);
      assert.equal(dockerCalls[1][0], 'create');
      assert.ok(dockerCalls[1].includes('PROPR_AGENT_LOGIN=1'));
      assert.deepEqual(dockerCalls[2], ['start', '-a', '-i', 'propr-agent-login-antigravity-existing-session']);

      fs.writeFileSync(path.join(cliPath, 'antigravity-oauth-token'), 'transient-token-fragment');
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(manager.get(started.id, 'owner').status, 'running');

      fs.writeFileSync(path.join(cliPath, 'antigravity-oauth-token'), antigravityCredential('refreshed-token'));
      await waitFor(() => manager.get(started.id, 'owner').status === 'succeeded');
      assert.match(manager.get(started.id, 'owner').output, /Authentication saved/);
    } finally {
      fs.rmSync(credentialPath, { recursive: true, force: true });
    }
  });
});
