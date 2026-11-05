import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { after, mock, test } from 'node:test';

let failing = false;
class FakeRedis {
    status = 'ready';
    on() { return this; }
    async eval(_script: string, _keys: number, _data: string, _meta: string, text: string) {
        if (failing) throw new Error('temporary outage');
        return text.length;
    }
    async quit() { return 'OK'; }
    disconnect() {}
}
mock.module('ioredis', { namedExports: { Redis: FakeRedis, default: FakeRedis } });
const { ClaudeGoalStream } = await import('../packages/core/src/agents/impl/claudeNativeGoal.js');
const { AppServerConnection } = await import('../packages/core/src/agents/impl/codexAppServerConnection.js');
const { closeConnection } = await import('../packages/core/src/db/connection.js');
after(() => closeConnection());

function fakeChild() {
    return Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: new PassThrough(),
        exitCode: null as number | null,
        signalCode: null,
        kill: () => true,
    });
}

/** Writes over 16 MiB of complete records while publication fails, until the session reports a failure. */
async function overflow(child: ReturnType<typeof fakeChild>, failed: () => Error | null): Promise<Error | null> {
    const record = `${JSON.stringify({ type: 'system', text: 'x'.repeat(64 * 1024) })}\n`;
    for (let index = 0; index < 300 && !failed(); index += 1) {
        if (!child.stdout.write(record)) await once(child.stdout, 'drain');
    }
    for (let turn = 0; turn < 100 && !failed(); turn += 1) await new Promise(resolve => setImmediate(resolve));
    return failed();
}

for (const kind of ['claude-goal', 'codex-app-server'] as const) {
    test(`a ${kind} session fails once its unpublished output passes the bound`, async () => {
        const child = fakeChild();
        const session = kind === 'claude-goal'
            ? new ClaudeGoalStream(child as never, 'session-backlog', async () => undefined)
            : new AppServerConnection(child as never, 'session-backlog', async () => undefined);
        failing = true;
        try {
            const error = await overflow(child, () => session.closeError);
            assert.match(error?.message ?? '', /Live output publication fell more than 16777216 bytes behind/);
        } finally {
            failing = false;
            child.exitCode = 0;
            await assert.rejects(session instanceof ClaudeGoalStream ? session.shutdown() : session.close(), /fell more than/);
        }
    });
}
