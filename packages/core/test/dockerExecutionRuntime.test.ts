import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureJsonLineMessages }
    from '../src/claude/docker/dockerExecutionRuntime.js';

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

    captureJsonLineMessages('\n', '2026-08-04T10:00:02.000Z', context);
    assert.equal(
        messageTimestamps.get('message-2'),
        '2026-08-04T10:00:02.000Z'
    );
});
