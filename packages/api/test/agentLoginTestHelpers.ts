import { EventEmitter } from 'node:events';
import os from 'node:os';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Response } from 'express';
import type { AgentConfig } from '@propr/core';
import { AgentLoginSessionManager } from '../services/agentLoginSessionManager.js';

export const defaultCodexConfigPath = os.tmpdir();

export function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'codex-1',
    type: 'codex',
    alias: 'codex',
    enabled: true,
    dockerImage: 'propr/agent:test',
    configPath: defaultCodexConfigPath,
    supportedModels: ['gpt-test'],
    ...overrides,
  };
}

export function fakeChild(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  });
  return child;
}

export function responseRecorder() {
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

export const managers: AgentLoginSessionManager[] = [];

export function managerWith(child: ChildProcessWithoutNullStreams, dockerCalls: string[][] = []) {
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
