import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, describe, test } from 'node:test';
import type { FlatRequest } from '../requestTypes.js';
import { closeConnection, shutdownQueue } from '@propr/core';
import {
  AGENT_LOGIN_DESCRIPTORS,
  buildAgentLoginCommand,
  getManagedAgentConfigPath,
  getPiLoginProviders,
} from '@propr/shared';
import { createAgentLoginRoutes } from '../routes/agentLoginRoutes.js';
import { AgentLoginInputError } from '../services/agentLoginSessionManager.js';
import {
  buildAgentLoginCreateArgs,
  resolveAgentLoginConfigPath,
} from '../services/agentLoginDocker.js';
import { agent, fakeChild, managers, managerWith, responseRecorder } from './agentLoginTestHelpers.js';

afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.close()));
});

after(async () => {
  await closeConnection();
  await shutdownQueue();
});

describe('Pi login routes', () => {
  test('passes a Pi provider and login method through to the session', async () => {
    const previousRoot = process.env.PROPR_MANAGED_CREDENTIALS_DIR;
    const managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-agent-login-'));
    try {
      process.env.PROPR_MANAGED_CREDENTIALS_DIR = managedRoot;
      const dockerCalls: string[][] = [];
      const manager = managerWith(fakeChild(), dockerCalls);
      const pi = agent({
        id: 'pi-1', type: 'pi', alias: 'pi', configPath: getManagedAgentConfigPath('pi-1', 'pi'),
        supportedModels: ['pi-anthropic/claude-sonnet-5-5'],
      });
      const routes = createAgentLoginRoutes({ sessionManager: manager, resolveAgent: async () => pi });

      const invalid = responseRecorder();
      await routes.startLogin({
        params: { agentId: 'pi-1' }, body: { provider: 42 }, user: { username: 'owner' },
      } as unknown as FlatRequest, invalid.response);
      assert.equal(invalid.record.status, 400);

      const started = responseRecorder();
      await routes.startLogin({
        params: { agentId: 'pi-1' }, body: { provider: 'openrouter', apiKey: true }, user: { username: 'owner' },
      } as unknown as FlatRequest, started.response);
      assert.equal(started.record.status, 202);
      const session = started.record.body as { provider?: string; apiKey?: boolean };
      assert.equal(session.provider, 'openrouter');
      assert.equal(session.apiKey, true);
      const create = dockerCalls.find(args => args[0] === 'create')!;
      assert.deepEqual(create.slice(-5), ['pi', 'auth', 'login', 'openrouter', '--api-key']);
    } finally {
      if (previousRoot === undefined) delete process.env.PROPR_MANAGED_CREDENTIALS_DIR;
      else process.env.PROPR_MANAGED_CREDENTIALS_DIR = previousRoot;
      fs.rmSync(managedRoot, { recursive: true, force: true });
    }
  });
});

describe('Pi login descriptor', () => {
  const piDescriptor = AGENT_LOGIN_DESCRIPTORS.pi;

  test('builds a headless provider login, or an API-key login', () => {
    assert.deepEqual(buildAgentLoginCommand(piDescriptor, { provider: 'anthropic' }), ['pi', 'auth', 'login', 'anthropic', '--no-browser']);
    assert.deepEqual(buildAgentLoginCommand(piDescriptor, { provider: 'OpenRouter', apiKey: true }), ['pi', 'auth', 'login', 'openrouter', '--api-key']);
    assert.throws(() => buildAgentLoginCommand(piDescriptor), /requires a provider/);
    assert.throws(() => buildAgentLoginCommand(piDescriptor, { provider: '--api-key' }), /lowercase letters/);
    assert.throws(() => buildAgentLoginCommand(piDescriptor, { provider: 'a b' }), /lowercase letters/);
    assert.deepEqual(buildAgentLoginCommand(AGENT_LOGIN_DESCRIPTORS.codex), ['codex', 'login', '--device-auth']);
    assert.throws(() => buildAgentLoginCommand(AGENT_LOGIN_DESCRIPTORS.codex, { provider: 'openai' }), /does not take a provider/);
  });

  test('derives login providers from Pi model ids, default model first', () => {
    assert.deepEqual(getPiLoginProviders([
      'pi-anthropic/claude-opus-5-5', 'pi-openrouter/mistralai/devstral-2512', 'pi:pi-anthropic/claude-sonnet-5-5', 'gpt-6-luna',
    ], 'pi-openrouter/mistralai/devstral-2512'), ['openrouter', 'anthropic']);
    assert.deepEqual(getPiLoginProviders([]), []);
  });

  test('runs the login on the managed credential dir with PI_CODING_AGENT_DIR mode enabled', () => {
    const previousRoot = process.env.PROPR_MANAGED_CREDENTIALS_DIR;
    try {
      process.env.PROPR_MANAGED_CREDENTIALS_DIR = '/var/lib/propr/agent-credentials';
      const pi = agent({ id: 'pi-1', type: 'pi', alias: 'pi', configPath: getManagedAgentConfigPath('pi-1', 'pi') });
      assert.equal(pi.configPath, '~/.propr/agent-credentials/pi-1/.pi/agent');
      const credentialPath = resolveAgentLoginConfigPath(pi);
      assert.equal(credentialPath, '/var/lib/propr/agent-credentials/pi-1/.pi/agent');
      const args = buildAgentLoginCreateArgs(
        pi,
        { ...piDescriptor, command: buildAgentLoginCommand(piDescriptor, { provider: 'openai-codex' }) },
        credentialPath,
        'propr-agent-login-test',
      );
      assert.ok(args.includes(`${credentialPath}:/home/node/.pi/agent:rw`));
      assert.ok(args.includes('PROPR_AGENT_TYPE=pi'));
      assert.ok(args.includes('PROPR_PI_LOGIN=1'));
      assert.ok(args.includes('PROPR_PI_SOURCE_DIR=/home/node/.pi/agent'));
      assert.ok(args.includes('PROPR_MANAGED_CREDENTIALS=1'));
      assert.ok(args.includes('-t'), 'Pi login needs a terminal');
      assert.deepEqual(args.slice(-5), ['pi', 'auth', 'login', 'openai-codex', '--no-browser']);
    } finally {
      if (previousRoot === undefined) delete process.env.PROPR_MANAGED_CREDENTIALS_DIR;
      else process.env.PROPR_MANAGED_CREDENTIALS_DIR = previousRoot;
    }
  });

  test('defaults the provider to the agent\'s default model and refuses an agent without Pi models', async () => {
    const manager = managerWith(fakeChild());
    const previousRoot = process.env.PROPR_MANAGED_CREDENTIALS_DIR;
    const managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-agent-login-'));
    try {
      process.env.PROPR_MANAGED_CREDENTIALS_DIR = managedRoot;
      const pi = agent({
        id: 'pi-2', type: 'pi', alias: 'pi', configPath: getManagedAgentConfigPath('pi-2', 'pi'),
        supportedModels: ['pi-anthropic/claude-sonnet-5-5', 'pi-google/gemini-4-argon'], defaultModel: 'pi-google/gemini-4-argon',
      });
      const started = await manager.start(pi, 'owner');
      assert.equal(started.provider, 'google');
      assert.equal(started.apiKey, false);
      await manager.cancel(started.id, 'owner');
      await assert.rejects(manager.start({ ...pi, id: 'pi-3', configPath: getManagedAgentConfigPath('pi-3', 'pi'), supportedModels: [], defaultModel: undefined }, 'owner'), AgentLoginInputError);
    } finally {
      if (previousRoot === undefined) delete process.env.PROPR_MANAGED_CREDENTIALS_DIR;
      else process.env.PROPR_MANAGED_CREDENTIALS_DIR = previousRoot;
      fs.rmSync(managedRoot, { recursive: true, force: true });
    }
  });
});
