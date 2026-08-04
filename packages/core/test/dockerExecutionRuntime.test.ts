import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    captureJsonLineMessages,
    cleanupRedisStreaming,
    flushJsonLineMessages
}
    from '../src/claude/docker/dockerExecutionRuntime.js';
import {
    executeDockerCommand,
    ExecutionAbortedError
} from '../src/claude/docker/dockerExecutor.js';

test('JSON-line capture retains records fragmented across stdout chunks', () => {
    const state = { sessionIdDetected: false };
    const messageTimestamps = new Map<string, string>();
    const sessions: Array<{ sessionId: string; conversationId?: string }> = [];
    const context = {
        state,
        messageTimestamps,
        onSessionId: (sessionId: string, conversationId?: string) => {
            sessions.push({ sessionId, conversationId });
        }
    };

    captureJsonLineMessages(
        '{"type":"assistant","message":{"id":"message-',
        '2026-08-04T10:00:00.000Z',
        context
    );
    assert.equal(messageTimestamps.size, 0);
    captureJsonLineMessages(
        '1"},"session_id":"session-1","conversation_id":"conversation-1"}\n'
            + '{"type":"user","message":{"id":"message-2"}}',
        '2026-08-04T10:00:01.000Z',
        context
    );

    assert.deepEqual(sessions, [{
        sessionId: 'session-1', conversationId: 'conversation-1'
    }]);
    assert.equal(
        messageTimestamps.get('message-1'),
        '2026-08-04T10:00:01.000Z'
    );
    assert.equal(messageTimestamps.has('message-2'), false);

    flushJsonLineMessages('2026-08-04T10:00:02.000Z', context);
    assert.equal(
        messageTimestamps.get('message-2'),
        '2026-08-04T10:00:01.000Z'
    );
});

test('JSON-line capture flushes an unterminated final session record', () => {
    const state = { sessionIdDetected: false };
    const messageTimestamps = new Map<string, string>();
    const sessions: string[] = [];
    const context = {
        state,
        messageTimestamps,
        onSessionId: (sessionId: string) => { sessions.push(sessionId); }
    };
    captureJsonLineMessages(
        '{"type":"assistant","message":{"id":"final"},"session_id":"final-session"}',
        '2026-08-04T10:00:03.000Z',
        context
    );

    flushJsonLineMessages('2026-08-04T10:00:04.000Z', context);

    assert.deepEqual(sessions, ['final-session']);
    assert.equal(messageTimestamps.get('final'), '2026-08-04T10:00:03.000Z');
});

test('JSON-line capture bounds a non-newline record and resumes at the next boundary', () => {
    const state: {
        sessionIdDetected: boolean;
        jsonLineBuffer?: string;
        discardJsonLineUntilNewline?: boolean;
    } = { sessionIdDetected: false };
    const messageTimestamps = new Map<string, string>();
    const context = { state, messageTimestamps };

    captureJsonLineMessages('x'.repeat(1024 * 1024 + 1), '2026-08-04T10:00:00.000Z', context);
    assert.equal(state.jsonLineBuffer, '');
    assert.equal(state.discardJsonLineUntilNewline, true);
    captureJsonLineMessages(
        'discarded-tail\n{"type":"assistant","message":{"id":"recovered"}}\n',
        '2026-08-04T10:00:01.000Z',
        context
    );
    assert.equal(messageTimestamps.get('recovered'), '2026-08-04T10:00:01.000Z');
});

test('Redis streaming cleanup closes the client when its final write fails', async () => {
    let quitCalls = 0;
    const client = {
        setex: async () => { throw new Error('final write failed'); },
        quit: async () => { quitCalls++; }
    };

    await cleanupRedisStreaming({
        client: client as never,
        interval: null,
        pendingWrite: null
    }, 'task-1', false, 'final output');

    assert.equal(quitCalls, 1);
});

test('Redis streaming cleanup force-disconnects operations that miss their deadlines', async () => {
    let disconnectCalls = 0;
    const client = {
        setex: async () => new Promise<never>(() => undefined),
        quit: async () => undefined,
        disconnect: () => { disconnectCalls++; }
    };

    await cleanupRedisStreaming({
        client: client as never,
        interval: null,
        pendingWrite: new Promise<void>(() => undefined),
        operationTimeoutMs: 5
    }, 'task-timeout', false, 'final output');

    assert.ok(disconnectCalls >= 2);
});

test('abort escalation kills a child that ignores SIGTERM', async () => {
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 200);
    const startedAt = Date.now();
    try {
        await assert.rejects(executeDockerCommand(process.execPath, [
            '-e',
            'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'
        ], {
            signal: controller.signal,
            timeout: 5_000
        }), ExecutionAbortedError);
    } finally {
        clearTimeout(abortTimer);
    }
    assert.ok(Date.now() - startedAt < 3_000);
});
