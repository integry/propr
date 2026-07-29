import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { after, afterEach, describe, test } from 'node:test';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Request, Response } from 'express';
import type { AgentConfig } from '@propr/core';
import { closeConnection, shutdownQueue } from '@propr/core';
import { AGENT_LOGIN_DESCRIPTORS } from '@propr/shared';
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

    (child.stdout as PassThrough).write('\u001b[32mOpen https://example.test/device\u001b[0m\r\n');
    const running = manager.write(started.id, 'owner', 'ABCD-1234\n');
    assert.match(running.output, /Open https:\/\/example\.test\/device/);
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
    routes.getLogin({
      params: { agentId: 'codex-1', sessionId: session.id },
      user: { username: 'other-user' },
    } as unknown as Request, otherResponse.response);

    assert.equal(otherResponse.record.status, 404);
    assert.deepEqual(otherResponse.record.body, { error: 'Agent login session not found' });
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
