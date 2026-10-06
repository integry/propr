import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentActivityWatchdog, type AgentWatchdogSettings, type AgentWatchdogTrip } from '../src/claude/docker/agentActivityWatchdog.js';
import { classifyAgentOutputLine } from '../src/claude/docker/agentOutputActivity.js';
import { resolveAgentTerminationReason, describeAgentTermination } from '../src/agents/termination.js';
import { resolveAgentWatchdogSettings } from '../src/config/agentWatchdogSettings.js';

const SETTINGS: AgentWatchdogSettings = { stallTimeoutMs: 1_000, toolStallTimeoutMs: 5_000, degenerateOutputLimit: 3 };

function harness(settings: AgentWatchdogSettings = SETTINGS) {
    let now = 0;
    const trips: AgentWatchdogTrip[] = [];
    const watchdog = new AgentActivityWatchdog(settings, { now: () => now, onTrip: trip => trips.push(trip) });
    return { watchdog, trips, advance: (ms: number) => { now += ms; return watchdog.check(); } };
}

test('silence past the stall threshold trips once with the inactivity rule', () => {
    const { trips, advance } = harness();
    assert.equal(advance(999), null);
    const trip = advance(1);
    assert.equal(trip?.rule, 'inactivity');
    assert.equal(trip?.terminationReason, 'stalled');
    assert.equal(trip?.threshold, 1_000);
    assert.equal(trip?.silentSeconds, 1);
    assert.match(trip!.message, /Agent watchdog stopped the run \(stalled\)/);
    advance(10_000);
    assert.equal(trips.length, 1, 'the trip callback fires at most once');
});

test('any output resets the silence timer', () => {
    const { watchdog, trips, advance } = harness();
    advance(900);
    watchdog.recordActivity();
    assert.equal(advance(900), null);
    watchdog.observeLine('not json: a plain log line');
    assert.equal(advance(900), null);
    assert.equal(trips.length, 0);
});

test('a tool start extends the threshold to the tool threshold, measured from the tool start', () => {
    const { watchdog, advance } = harness();
    advance(500);
    watchdog.observeLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } }));
    assert.equal(advance(4_999), null, 'a silent tool call is allowed the longer threshold');
    const trip = advance(1);
    assert.equal(trip?.rule, 'tool_inactivity');
    assert.equal(trip?.threshold, 5_000);
});

test('a finished tool returns to the normal stall threshold', () => {
    const { watchdog, advance } = harness();
    watchdog.recordToolStart();
    advance(3_000);
    watchdog.observeLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }));
    assert.equal(advance(999), null);
    assert.equal(advance(1)?.rule, 'inactivity');
});

test('a zero tool threshold never stops a run while a tool call is running', () => {
    const { watchdog, advance } = harness({ ...SETTINGS, toolStallTimeoutMs: 0 });
    watchdog.recordToolStart();
    assert.equal(advance(60 * 60 * 1000), null);
});

test('whitespace-only deltas count, empty deltas do not, real text resets the count', () => {
    const { watchdog, trips } = harness();
    watchdog.recordTextDelta(' ');
    watchdog.recordTextDelta('');
    watchdog.recordTextDelta('\n');
    watchdog.recordTextDelta('');
    watchdog.recordTextDelta('real text');
    watchdog.recordTextDelta('\t');
    watchdog.recordTextDelta(' ');
    assert.equal(trips.length, 0);
    watchdog.recordTextDelta('  \n ');
    assert.equal(trips.length, 1);
    assert.equal(trips[0].rule, 'degenerate_output');
    assert.equal(trips[0].terminationReason, 'degenerate_output');
    assert.equal(trips[0].degenerateDeltas, 3);
    assert.match(trips[0].message, /Agent watchdog stopped the run \(degenerate_output\)/);
});

test('streamed whitespace deltas from a provider trip the degenerate rule', () => {
    const { watchdog, trips } = harness();
    const delta = (text: string) => JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
    for (let index = 0; index < 3; index += 1) watchdog.observeLine(delta(' '));
    assert.equal(trips[0]?.rule, 'degenerate_output');
});

test('disabled rules (0) never trip', () => {
    const { watchdog, trips, advance } = harness({ stallTimeoutMs: 0, toolStallTimeoutMs: 0, degenerateOutputLimit: 0 });
    assert.equal(watchdog.enabled, false);
    for (let index = 0; index < 1_000; index += 1) watchdog.recordTextDelta(' ');
    assert.equal(advance(7 * 24 * 60 * 60 * 1000), null);
    assert.equal(trips.length, 0);
});

test('each supported agent protocol reports text, tool start and tool end', () => {
    const cases: Array<[string, unknown, string]> = [
        // Claude stream-json
        ['claude text', { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }, 'text'],
        ['claude tool', { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a' }] } }, 'tool_start'],
        ['claude result', { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a' }] } }, 'tool_end'],
        ['claude prompt', { type: 'user', message: { content: [{ type: 'text', text: '  ' }] } }, 'activity'],
        // Codex exec --json
        ['codex command start', { type: 'item.started', item: { type: 'command_execution', command: 'npm test' } }, 'tool_start'],
        ['codex command end', { type: 'item.completed', item: { type: 'command_execution', exit_code: 0 } }, 'tool_end'],
        ['codex message', { type: 'item.completed', item: { type: 'agent_message', text: 'done' } }, 'text'],
        ['codex legacy exec', { msg: { type: 'exec_command_begin' } }, 'tool_start'],
        ['codex legacy delta', { msg: { type: 'agent_message_delta', delta: ' ' } }, 'text'],
        // OpenCode parts
        ['opencode running tool', { type: 'tool_use', part: { type: 'tool', state: { status: 'running' } } }, 'tool_start'],
        ['opencode finished tool', { type: 'tool_use', part: { type: 'tool', state: { status: 'completed' } } }, 'tool_end'],
        ['opencode text', { type: 'text', part: { type: 'text', text: 'ok' } }, 'text'],
        // Antigravity legacy events
        ['antigravity tool', { type: 'tool_use', tool_name: 'run', tool_id: 'x', parameters: {} }, 'tool_start'],
        ['antigravity result', { type: 'tool_result', tool_id: 'x', status: 'success' }, 'tool_end'],
        ['antigravity message', { type: 'message', role: 'assistant', content: 'working', delta: true }, 'text'],
        ['init', { type: 'system', subtype: 'init' }, 'activity'],
    ];
    for (const [label, event, kind] of cases) {
        assert.deepEqual(classifyAgentOutputLine(JSON.stringify(event)).map(activity => activity.kind), [kind], label);
    }
    assert.deepEqual(classifyAgentOutputLine('{"truncated": '), [{ kind: 'activity' }]);
});

test('every tool call in one record is classified, with its call id', () => {
    const claude = { type: 'assistant', message: { content: [{ type: 'text', text: 'Running both' }, { type: 'tool_use', id: 'a' }, { type: 'tool_use', id: 'b' }] } };
    assert.deepEqual(classifyAgentOutputLine(JSON.stringify(claude)), [
        { kind: 'text', text: 'Running both' }, { kind: 'tool_start', id: 'a' }, { kind: 'tool_start', id: 'b' },
    ]);
    const vibe = { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'bash' } }, { id: 'c2', function: { name: 'grep' } }] };
    assert.deepEqual(classifyAgentOutputLine(JSON.stringify(vibe)), [{ kind: 'tool_start', id: 'c1' }, { kind: 'tool_start', id: 'c2' }]);
    assert.deepEqual(classifyAgentOutputLine(JSON.stringify({ role: 'tool', tool_call_id: 'c1', content: 'ok' })), [{ kind: 'tool_end', id: 'c1' }]);
    assert.deepEqual(classifyAgentOutputLine(JSON.stringify({ role: 'assistant', content: 'plain reply' })), [{ kind: 'activity' }]);
    assert.deepEqual(classifyAgentOutputLine(JSON.stringify({ type: 'item.started', item: { id: 'item_1', type: 'command_execution' } })), [{ kind: 'tool_start', id: 'item_1' }]);
});

test('a multi-tool message keeps the tool threshold until every result has arrived', () => {
    const { watchdog, advance } = harness();
    watchdog.observeLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a' }, { type: 'tool_use', id: 'b' }] } }));
    advance(2_000);
    watchdog.observeLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] } }));
    // The same result seen twice (stdout and a transcript) must not close the other call.
    watchdog.observeLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] } }));
    assert.equal(watchdog.openTools, 1);
    assert.equal(advance(4_999), null, 'tool b is still running silently');
    assert.equal(advance(1)?.rule, 'tool_inactivity');
});

test('the last outstanding result restores the ordinary stall threshold', () => {
    const { watchdog, advance } = harness();
    watchdog.observeLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a' }, { type: 'tool_use', id: 'b' }] } }));
    watchdog.observeLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b' }] } }));
    watchdog.observeLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a' }] } }));
    // A replayed start of a finished call does not reopen it.
    watchdog.observeLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a' }] } }));
    assert.equal(watchdog.openTools, 0);
    assert.equal(advance(1_000)?.rule, 'inactivity');
});

test('output observed before the settings are configured keeps its time and tool state', () => {
    let now = 0;
    const trips: AgentWatchdogTrip[] = [];
    const watchdog = new AgentActivityWatchdog({ stallTimeoutMs: 0, toolStallTimeoutMs: 0, degenerateOutputLimit: 0 }, { now: () => now, onTrip: trip => trips.push(trip) });
    now = 100;
    watchdog.observeLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a' }] } }));
    for (let index = 0; index < 3; index += 1) watchdog.recordTextDelta(' ');
    assert.equal(trips.length, 0, 'placeholder settings never trip');
    watchdog.configure(SETTINGS);
    assert.equal(trips[0]?.rule, 'degenerate_output', 'deltas counted while loading apply once the limit is known');
    const loading = new AgentActivityWatchdog({ stallTimeoutMs: 0, toolStallTimeoutMs: 0, degenerateOutputLimit: 0 }, { now: () => now, onTrip: () => undefined });
    loading.observeLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a' }] } }));
    loading.configure(SETTINGS);
    now += 4_999;
    assert.equal(loading.check(), null, 'a tool started while loading keeps the tool threshold');
    now += 1;
    assert.equal(loading.check()?.rule, 'tool_inactivity');
});

test('watchdog stops resolve to their own termination reasons', () => {
    assert.equal(resolveAgentTerminationReason({ watchdogTrip: { terminationReason: 'stalled' } }), 'stalled');
    assert.equal(resolveAgentTerminationReason({ error: 'warning\nAgent watchdog stopped the run (degenerate_output): x' }), 'degenerate_output');
    assert.equal(resolveAgentTerminationReason({ timedOut: true }), 'timeout');
    assert.match(describeAgentTermination('stalled'), /stall watchdog/);
});

test('settings: env is the default, a stored value overrides it, invalid values fall back', () => {
    const env = { AGENT_STALL_TIMEOUT_MS: '120000', AGENT_TOOL_STALL_TIMEOUT_MS: 'soon', AGENT_DEGENERATE_OUTPUT_LIMIT: '0' };
    assert.deepEqual(resolveAgentWatchdogSettings({}, {}), { stallTimeoutMs: 600_000, toolStallTimeoutMs: 1_800_000, degenerateOutputLimit: 50 });
    assert.deepEqual(resolveAgentWatchdogSettings({}, env), { stallTimeoutMs: 120_000, toolStallTimeoutMs: 1_800_000, degenerateOutputLimit: 0 });
    assert.deepEqual(resolveAgentWatchdogSettings({ agent_stall_timeout_ms: 0, agent_tool_stall_timeout_ms: null, agent_degenerate_output_limit: -4 }, env), {
        stallTimeoutMs: 0,
        toolStallTimeoutMs: 1_800_000,
        degenerateOutputLimit: 0,
    });
    assert.equal(resolveAgentWatchdogSettings({ agent_stall_timeout_ms: 'abc' }, {}).stallTimeoutMs, 600_000);
});
