import { after, afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert';
import type { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Knex } from 'knex';
import type { RedisClientType } from 'redis';
import type { Server as SocketIOServer } from 'socket.io';
import { closeConnection } from '@propr/core';
import type { TaskLiveUpdatePayload } from '@propr/shared';

// The saved Claude agent keeps the portable default; the launcher maps it to a host directory.
mock.module('../services/taskWatcherLookup.js', {
  namedExports: {
    findAgentConfigForTask: async () => ({
      id: 'claude-1', type: 'claude', alias: 'claude', enabled: true,
      dockerImage: 'propr/agent:test', configPath: '~/.claude', supportedModels: [],
    }),
    findExecutionStartTimestampForTask: async () => null,
    findLatestExecutionStartForTask: async () => null,
  },
});
const { TaskWatcherManager } = await import('../services/taskWatcher.js');

after(async () => {
  await closeConnection();
});

const ENV_KEYS = ['HOME', 'PROPR_CONTAINERIZED', 'CLAUDE_CONFIG_PATH', 'HOST_CLAUDE_DIR'] as const;
let previousEnv: Record<string, string | undefined>;
let backendHome: string;
let hostClaudeDir: string;

beforeEach(() => {
  previousEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  backendHome = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-backend-home-'));
  hostClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-host-claude-'));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.HOME = backendHome;
  process.env.PROPR_CONTAINERIZED = '1';
  process.env.CLAUDE_CONFIG_PATH = hostClaudeDir;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
  fs.rmSync(backendHome, { recursive: true, force: true });
  fs.rmSync(hostClaudeDir, { recursive: true, force: true });
});

function harness(sessionId: string) {
  const emitted: TaskLiveUpdatePayload[] = [];
  const io = {
    to: () => ({ emit: (_event: string, payload: TaskLiveUpdatePayload) => emitted.push(payload) }),
    sockets: { adapter: { rooms: new Map() } },
  } as unknown as SocketIOServer;
  const manager = new TaskWatcherManager(io);
  // A retained session whose live Redis output is no longer available.
  const redisClient = {
    get: async (key: string) => key.startsWith('worker:state:')
      ? JSON.stringify({ history: [{ state: 'claude_execution', metadata: { sessionId } }] })
      : null,
  } as unknown as RedisClientType;
  manager.setDeps({ redisClient, db: {} as Knex });
  return { manager, emitted };
}

function writeConversation(root: string, sessionId: string, text: string): string {
  const dir = path.join(root, 'projects', '-home-node-workspace');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({
    type: 'assistant', timestamp: '2026-10-15T00:00:00Z',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  })}\n`);
  return file;
}

test('reads an existing Claude conversation from the mapped default root, not backend HOME', async () => {
  const { manager, emitted } = harness('session-mapped');
  writeConversation(hostClaudeDir, 'session-mapped', 'from the mapped host store');
  try {
    await manager.startTaskWatcher('task-mapped-existing');
    await manager.sendTaskLiveUpdate('task-mapped-existing', true);

    assert.strictEqual(emitted.length, 1);
    assert.ok(JSON.stringify(emitted[0].events).includes('from the mapped host store'));
    assert.ok(!fs.existsSync(path.join(backendHome, '.claude')), 'backend HOME is never used');
  } finally {
    await manager.closeAll();
  }
});

test('keeps the mapped conversation path after switching from directory to file watching', async () => {
  const { manager, emitted } = harness('session-created');
  try {
    await manager.startTaskWatcher('task-mapped-created');
    const file = writeConversation(hostClaudeDir, 'session-created', 'created under the mapped host store');
    // Deliver the creation event to the directory watcher's own handler
    // rather than waiting on filesystem polling.
    const watchers = (manager as unknown as { taskWatchers: Map<string, { watcher: EventEmitter | null; watchingForCreation: boolean }> }).taskWatchers;
    assert.strictEqual(watchers.get('task-mapped-created')?.watchingForCreation, true);
    watchers.get('task-mapped-created')!.watcher!.emit('add', file);

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && emitted.length === 0) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }

    assert.strictEqual(watchers.get('task-mapped-created')?.watchingForCreation, false);
    assert.strictEqual(emitted.length, 1, 'the switched file watcher emits the mapped conversation');
    assert.ok(JSON.stringify(emitted[0].events).includes('created under the mapped host store'));
    assert.ok(!fs.existsSync(path.join(backendHome, '.claude')), 'backend HOME is never used');
  } finally {
    await manager.closeAll();
  }
});
