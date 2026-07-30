import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, afterEach, describe, test } from 'node:test';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Request, Response } from 'express';
import type { AgentConfig } from '@propr/core';
import { closeConnection, shutdownQueue } from '@propr/core';
import {
  AGENT_LOGIN_DESCRIPTORS,
  getManagedAgentConfigPath,
} from '@propr/shared';
import { createAgentLoginRoutes } from '../routes/agentLoginRoutes.js';
import {
  AgentLoginInputError,
  AgentLoginConflictError,
  AgentLoginSessionManager,
} from '../services/agentLoginSessionManager.js';
import {
  buildAgentLoginCreateArgs,
  resolveAgentLoginConfigPath,
} from '../services/agentLoginDocker.js';

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

function responseRecorder() {
  const record: { status: number; body?: unknown } = { status: 200 };
  const response = {
    status(code: number) {
      record.status = code;
      return response;
    },
    json(body: unknown) {
      record.body = body;
      return response;
    },
  } as unknown as Response;
  return { response, record };
}

const managers: AgentLoginSessionManager[] = [];

function managerWith(child: ChildProcessWithoutNullStreams, dockerCalls: string[][] = []) {
  const manager = new AgentLoginSessionManager({
    id: () => 'session-1',
    runDocker: async args => {
      dockerCalls.push(args);
      return { stdout: '', stderr: '' };
    },
    spawnDocker: args => {
      dockerCalls.push(args);
      return child;
    },
    sessionTimeoutMs: 60_000,
    sessionRetentionMs: 60_000,
  });
  managers.push(manager);
  return manager;
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.close()));
});

after(async () => {
  await closeConnection();
  await shutdownQueue();
});

describe('agent login session manager', () => {
  test('builds an allowlisted Docker login container without forwarding host secrets', () => {
    const args = buildAgentLoginCreateArgs(
      agent(),
      AGENT_LOGIN_DESCRIPTORS.codex,
      '/tmp/propr-test-codex',
      'propr-agent-login-test',
    );

    assert.deepEqual(args.slice(-3), ['codex', 'login', '--device-auth']);
    assert.ok(args.includes('/tmp/propr-test-codex:/home/node/.codex:rw'));
    assert.ok(args.includes('PROPR_AGENT_TYPE=codex'));
    assert.equal(args.some(value => value.includes('GH_TOKEN')), false);
    assert.equal(args.some(value => value.includes('ANTHROPIC_API_KEY')), false);
  });

  test('maps a ProPR-managed account to the managed host root and marks its container ownership as safe to normalize', () => {
    const previousRoot = process.env.PROPR_MANAGED_CREDENTIALS_DIR;
    try {
      process.env.PROPR_MANAGED_CREDENTIALS_DIR = '/var/lib/propr/agent-credentials';
      const managedAgent = agent({
        configPath: getManagedAgentConfigPath('codex-1', 'codex'),
      });
      const credentialPath = resolveAgentLoginConfigPath(managedAgent);
      assert.equal(
        credentialPath,
        '/var/lib/propr/agent-credentials/codex-1/.codex',
      );

      const args = buildAgentLoginCreateArgs(
        managedAgent,
        AGENT_LOGIN_DESCRIPTORS.codex,
        credentialPath,
        'propr-agent-login-test',
        'test-stack',
      );
      assert.ok(args.includes('PROPR_MANAGED_CREDENTIALS=1'));
      assert.ok(args.includes('propr.agent-login.scope=test-stack'));
    } finally {
      if (previousRoot === undefined) delete process.env.PROPR_MANAGED_CREDENTIALS_DIR;
      else process.env.PROPR_MANAGED_CREDENTIALS_DIR = previousRoot;
    }
  });

  test('creates a ProPR-managed credential directory before starting Docker', async () => {
    const previousRoot = process.env.PROPR_MANAGED_CREDENTIALS_DIR;
    const managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-agent-login-'));
    try {
      process.env.PROPR_MANAGED_CREDENTIALS_DIR = managedRoot;
      const manager = managerWith(fakeChild());
      const managedAgent = agent({
        configPath: getManagedAgentConfigPath('codex-1', 'codex'),
      });

      const started = await manager.start(managedAgent, 'owner');
      assert.equal(started.status, 'running');
      assert.equal(
        fs.statSync(path.join(managedRoot, 'codex-1', '.codex')).isDirectory(),
        true,
      );
    } finally {
      if (previousRoot === undefined) delete process.env.PROPR_MANAGED_CREDENTIALS_DIR;
      else process.env.PROPR_MANAGED_CREDENTIALS_DIR = previousRoot;
      fs.rmSync(managedRoot, { recursive: true, force: true });
    }
  });

  test('fails clearly instead of resolving a default home path inside a containerized API', () => {
    const previousContainerized = process.env.PROPR_CONTAINERIZED;
    const previousCodexPath = process.env.CODEX_CONFIG_PATH;
    const previousHostCodexPath = process.env.HOST_CODEX_DIR;
    try {
      process.env.PROPR_CONTAINERIZED = '1';
      delete process.env.CODEX_CONFIG_PATH;
      delete process.env.HOST_CODEX_DIR;
      assert.throws(
        () => resolveAgentLoginConfigPath(agent({ configPath: '~/.codex' })),
        /has no host mapping/,
      );
    } finally {
      if (previousContainerized === undefined) delete process.env.PROPR_CONTAINERIZED;
      else process.env.PROPR_CONTAINERIZED = previousContainerized;
      if (previousCodexPath === undefined) delete process.env.CODEX_CONFIG_PATH;
      else process.env.CODEX_CONFIG_PATH = previousCodexPath;
      if (previousHostCodexPath === undefined) delete process.env.HOST_CODEX_DIR;
      else process.env.HOST_CODEX_DIR = previousHostCodexPath;
    }
  });

  test('rejects unsafe credential roots and option-like image names', () => {
    assert.throws(
      () => resolveAgentLoginConfigPath(agent({ configPath: '/' })),
      AgentLoginInputError,
    );
    assert.throws(
      () => buildAgentLoginCreateArgs(
        agent({ dockerImage: '--privileged' }),
        AGENT_LOGIN_DESCRIPTORS.codex,
        '/tmp/propr-test-codex',
        'propr-agent-login-test',
      ),
      AgentLoginInputError,
    );
  });

  test('streams sanitized output, accepts input, and records successful completion', async () => {
    const child = fakeChild();
    let stdin = '';
    child.stdin.on('data', chunk => {
      stdin += chunk.toString();
    });
    const dockerCalls: string[][] = [];
    const manager = managerWith(child, dockerCalls);

    const started = await manager.start(agent(), 'owner');
    assert.equal(started.status, 'running');
    assert.deepEqual(dockerCalls[0], ['image', 'inspect', 'propr/agent:test']);
    assert.equal(dockerCalls[1][0], 'create');
    assert.deepEqual(dockerCalls[2], ['start', '-a', '-i', 'propr-agent-login-session-1']);

    (child.stdout as PassThrough).write('\u001b[');
    (child.stdout as PassThrough).write('32mOpen https://example.test/device\u001b[0m\r');
    (child.stdout as PassThrough).write('\n\u001b]0;private title');
    (child.stdout as PassThrough).write(' payload\u0007Ready\n');
    const running = manager.write(started.id, 'owner', 'ABCD-1234\n');
    assert.match(running.output, /Open https:\/\/example\.test\/device/);
    assert.match(running.output, /Ready/);
    assert.equal(running.output.includes('32m'), false);
    assert.equal(running.output.includes('private title'), false);
    assert.equal(running.output.includes('payload'), false);
    assert.equal(running.output.includes('\u001b'), false);
    assert.equal(stdin, 'ABCD-1234\n');

    child.emit('close', 0);
    assert.equal(manager.get(started.id, 'owner').status, 'succeeded');
  });

  test('prevents concurrent logins that write the same credential directory', async () => {
    const manager = managerWith(fakeChild());
    await manager.start(agent(), 'owner');

    await assert.rejects(
      manager.start(agent({ id: 'codex-2', alias: 'codex-2' }), 'owner'),
      AgentLoginConflictError,
    );
  });

  test('pulls a missing agent image before creating the login container', async () => {
    const child = fakeChild();
    const dockerCalls: string[][] = [];
    const manager = new AgentLoginSessionManager({
      id: () => 'session-pull',
      runDocker: async args => {
        dockerCalls.push(args);
        if (args[0] === 'image') throw new Error('No such image');
        return { stdout: '', stderr: '' };
      },
      spawnDocker: args => {
        dockerCalls.push(args);
        return child;
      },
      sessionTimeoutMs: 60_000,
      sessionRetentionMs: 60_000,
    });
    managers.push(manager);

    const started = await manager.start(agent(), 'owner');
    assert.equal(started.status, 'running');
    assert.deepEqual(dockerCalls[0], ['image', 'inspect', 'propr/agent:test']);
    assert.deepEqual(dockerCalls[1], ['pull', 'propr/agent:test']);
    assert.equal(dockerCalls[2][0], 'create');
    assert.match(started.output, /pulling it now/);
  });

  test('renews the session deadline when the user sends input', async () => {
    let now = 1_000;
    const child = fakeChild();
    const manager = new AgentLoginSessionManager({
      id: () => 'session-renew',
      now: () => now,
      runDocker: async () => ({ stdout: '', stderr: '' }),
      spawnDocker: () => child,
      sessionTimeoutMs: 10_000,
      sessionRetentionMs: 60_000,
    });
    managers.push(manager);

    const started = await manager.start(agent(), 'owner');
    assert.equal(started.expiresAt, new Date(11_000).toISOString());
    now = 9_000;
    const renewed = manager.write(started.id, 'owner', '\n');
    assert.equal(renewed.updatedAt, new Date(9_000).toISOString());
    assert.equal(renewed.expiresAt, new Date(19_000).toISOString());
  });

  test('sweeps only orphaned login containers from the current stack scope', async () => {
    const dockerCalls: string[][] = [];
    const manager = new AgentLoginSessionManager({
      scope: 'stack-a',
      runDocker: async args => {
        dockerCalls.push(args);
        return {
          stdout: args[0] === 'ps' ? 'abcdef123456\n123456abcdef\n' : '',
          stderr: '',
        };
      },
    });
    managers.push(manager);

    assert.equal(await manager.cleanupOrphanedContainers(), 2);
    assert.deepEqual(dockerCalls[0], [
      'ps',
      '-aq',
      '--filter', 'label=propr.agent-login=true',
      '--filter', 'label=propr.agent-login.scope=stack-a',
    ]);
    assert.deepEqual(dockerCalls[1], ['rm', '-f', 'abcdef123456', '123456abcdef']);
  });
});

describe('agent login routes', () => {
  test('starts and returns only the requesting user login session', async () => {
    const child = fakeChild();
    const manager = managerWith(child);
    const routes = createAgentLoginRoutes({
      sessionManager: manager,
      resolveAgent: async id => id === 'codex-1' ? agent() : undefined,
    });
    const startedResponse = responseRecorder();

    await routes.startLogin({
      params: { agentId: 'codex-1' },
      user: { username: 'owner' },
    } as unknown as Request, startedResponse.response);

    assert.equal(startedResponse.record.status, 202);
    const session = startedResponse.record.body as { id: string; status: string };
    assert.equal(session.status, 'running');

    const otherResponse = responseRecorder();
    await routes.getLogin({
      params: { agentId: 'codex-1', sessionId: session.id },
      user: { username: 'other-user' },
    } as unknown as Request, otherResponse.response);

    assert.equal(otherResponse.record.status, 404);
    assert.deepEqual(otherResponse.record.body, { error: 'Agent login session not found' });
  });

  test('accepts the same agent alias on start and follow-up calls, including while disabled', async () => {
    const manager = managerWith(fakeChild());
    const disabledAgent = agent({ enabled: false, alias: 'codex-work' });
    const routes = createAgentLoginRoutes({
      sessionManager: manager,
      resolveAgent: async id => (
        id === disabledAgent.id || id === disabledAgent.alias ? disabledAgent : undefined
      ),
    });
    const startedResponse = responseRecorder();

    await routes.startLogin({
      params: { agentId: disabledAgent.alias },
      user: { username: 'owner' },
    } as unknown as Request, startedResponse.response);
    const session = startedResponse.record.body as { id: string; status: string };
    assert.equal(session.status, 'running');

    const getResponse = responseRecorder();
    await routes.getLogin({
      params: { agentId: disabledAgent.alias, sessionId: session.id },
      user: { username: 'owner' },
    } as unknown as Request, getResponse.response);
    assert.equal(getResponse.record.status, 200);
    assert.equal((getResponse.record.body as { agentId: string }).agentId, disabledAgent.id);
  });

  test('rejects interactive login for an unsupported agent type', async () => {
    const manager = managerWith(fakeChild());
    const routes = createAgentLoginRoutes({
      sessionManager: manager,
      resolveAgent: async () => agent({
        id: 'vibe-1',
        type: 'vibe',
        alias: 'vibe',
        configPath: '/tmp/propr-test-vibe',
      }),
    });
    const { response, record } = responseRecorder();

    await routes.startLogin({
      params: { agentId: 'vibe-1' },
      user: { username: 'owner' },
    } as unknown as Request, response);

    assert.equal(record.status, 400);
    assert.deepEqual(record.body, { error: 'vibe does not support interactive login' });
  });
});
