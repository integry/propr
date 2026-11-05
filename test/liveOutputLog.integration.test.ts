import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Redis } from 'ioredis';
import { LiveAgentOutput } from '../packages/core/src/agents/impl/utils/liveAgentOutput.js';
import { LiveOutputLog, liveOutputKey, liveOutputMetaKey, writeLiveOutput } from '../packages/core/src/agents/impl/utils/liveOutputLog.js';

async function connect(t: { skip: (message: string) => void }): Promise<Redis | null> {
    const redis = new Redis({
        host: process.env.REDIS_HOST ?? '127.0.0.1',
        port: Number.parseInt(process.env.REDIS_PORT ?? '6379', 10),
        connectTimeout: 250, enableReadyCheck: false, lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null,
    });
    redis.on('error', () => {});
    try {
        await redis.connect();
        return redis;
    } catch {
        redis.disconnect();
        t.skip('Redis is not available for live output integration testing');
        return null;
    }
}

const taskId = (name: string) => `live-output-log-${name}-${process.pid}-${Date.now()}`;

test('streams complete records once, transformed whole, and flushes the last partial record on close', async t => {
    const redis = await connect(t);
    if (!redis) return;
    const id = taskId('stream');
    try {
        await redis.set(liveOutputKey(id), 'left by an earlier execution\n');
        const log = new LiveOutputLog(id, { reset: true, redis, flushIntervalMs: 5, transformRecord: record => record.replace(/\u001b\[[0-9;]*m/g, '') });
        log.append('\u001b[32mfirst');
        log.append(' record\u001b[0m\nsecond');
        await log.flush();
        assert.equal(await redis.get(liveOutputKey(id)), 'first record\n', 'a new execution replaces earlier output; partial records wait');
        log.append(' record\nthird');
        await log.close();
        assert.equal(await redis.get(liveOutputKey(id)), 'first record\nsecond record\nthird\n');
        const meta = await redis.hgetall(liveOutputMetaKey(id));
        assert.equal(meta.head, 'first record');
        assert.equal(Number(meta.base), Number(meta.start), 'nothing of this execution was trimmed');
        assert.equal(await redis.ttl(liveOutputKey(id)) > 0, true);
    } finally {
        await redis.del(liveOutputKey(id), liveOutputMetaKey(id));
        redis.disconnect();
    }
});

test('trims the oldest records at a record boundary past the ceiling and never moves offsets backwards', async t => {
    const redis = await connect(t);
    if (!redis) return;
    const id = taskId('trim');
    try {
        await writeLiveOutput(redis, id, 'init record\n', { mode: 'reset', maximumBytes: 400 });
        let previousBase = 0;
        for (let index = 0; index < 60; index += 1) {
            await writeLiveOutput(redis, id, `record ${String(index).padStart(3, '0')} ${'x'.repeat(20)}\n`, { mode: 'append', maximumBytes: 400 });
            const base = Number(await redis.hget(liveOutputMetaKey(id), 'base'));
            assert.ok(base >= previousBase);
            previousBase = base;
        }
        const data = await redis.get(liveOutputKey(id));
        assert.ok(data && data.length <= 400);
        assert.match(data!, /^record \d{3} /, 'retained output starts at a record boundary');
        assert.ok(data!.endsWith('record 059 xxxxxxxxxxxxxxxxxxxx\n'));
        const meta = await redis.hgetall(liveOutputMetaKey(id));
        assert.equal(meta.head, 'init record', 'the first record survives trimming');
        assert.ok(Number(meta.base) > Number(meta.start));

        await writeLiveOutput(redis, id, 'next execution\n', { mode: 'reset', maximumBytes: 400 });
        const next = await redis.hgetall(liveOutputMetaKey(id));
        assert.equal(Number(next.epoch), Number(meta.epoch) + 1);
        assert.equal(Number(next.start), Number(next.base));
        assert.ok(Number(next.base) > Number(meta.base), 'a new execution continues the absolute offsets');
        assert.equal(next.head, 'next execution');
    } finally {
        await redis.del(liveOutputKey(id), liveOutputMetaKey(id));
        redis.disconnect();
    }
});

test('a message still arriving across the trim boundary is retained from its first delta', async t => {
    const redis = await connect(t);
    if (!redis) return;
    const id = taskId('trim-message');
    const delta = (content: string) => JSON.stringify({ type: 'message', role: 'assistant', delta: true, content: `${content} ${'.'.repeat(40)}` });
    const tool = (name: string) => JSON.stringify({ type: 'tool_use', tool_name: 'Bash', tool_id: name, parameters: { command: 'x'.repeat(200) } });
    const lines = (records: string[]) => `${records.join('\n')}\n`;
    /** Trims `before + after` so that the ceiling's cut falls inside the last record of `before`. */
    const trim = async (records: string[], after: string[]) => {
        const before = ['init', ...Array.from({ length: 20 }, (_, index) => tool(`earlier-${index}`)), ...records];
        const keep = Buffer.byteLength(lines(after)) + 10;
        await writeLiveOutput(redis, id, lines(before) + lines(after), { mode: 'reset' });
        await writeLiveOutput(redis, id, '', { maximumBytes: Math.ceil(keep * 4 / 3) });
        const data = (await redis.get(liveOutputKey(id)))!;
        const { base, start } = await redis.hgetall(liveOutputMetaKey(id));
        assert.ok(Buffer.byteLength(data) <= Math.ceil(keep * 4 / 3), 'the retained output stays under the ceiling');
        assert.notEqual(Number(base), Number(start), 'the output was trimmed');
        assert.equal(Number(base) - Number(start), Buffer.byteLength(lines(before) + lines(after)) - Buffer.byteLength(data));
        return data.split('\n')[0];
    };
    const rest = Array.from({ length: 40 }, (_, index) => delta(`rest ${index}`));
    try {
        // Records readers skip (stderr lines) do not end the message; the tool record before it does.
        assert.equal(await trim([delta('earlier'), tool('a'), delta('first'), 'stderr: warning', delta('second')], rest), delta('first'));
        // The message before a completed one is not retained for it.
        assert.equal(await trim([delta('first'), delta('second'), tool('a')], rest), rest[0]);
        // Nothing but a message is held back: plain records are cut where they were.
        assert.equal(await trim(['stderr: a plain diagnostic', 'stderr: a plain diagnostic'], rest), rest[0]);
        // A message whose deltas alone pass an eighth of the ceiling is cut where it was.
        const long = Array.from({ length: 12 }, (_, index) => delta(`long ${index}`));
        assert.equal(await trim(long, rest), rest[0]);
    } finally {
        await redis.del(liveOutputKey(id), liveOutputMetaKey(id));
        redis.disconnect();
    }
});

test('snapshot publication consumes reset once and close retains the final snapshot', async () => {
    const writes: Array<{ text: string; mode: string }> = [];
    const redis = {
        on: () => undefined,
        eval: async (_script: string, _keys: number, _data: string, _meta: string, text: string, _max: string, _ttl: string, mode: string) => {
            writes.push({ text, mode });
            return text.length;
        },
    } as unknown as Redis;
    const log = new LiveOutputLog('snapshots', { reset: true, redis });
    log.replace('first snapshot');
    await log.flush();
    log.replace('final snapshot');
    await log.close();
    await log.close();
    assert.deepEqual(writes, [
        { text: 'first snapshot', mode: 'reset' },
        { text: 'final snapshot', mode: 'replace' },
    ]);
});

test('snapshot close retains output and increments the epoch only at execution start', async t => {
    const redis = await connect(t);
    if (!redis) return;
    const id = taskId('snapshot');
    try {
        await writeLiveOutput(redis, id, 'earlier execution', { mode: 'reset' });
        const oldEpoch = Number(await redis.hget(liveOutputMetaKey(id), 'epoch'));
        const log = new LiveOutputLog(id, { reset: true, redis });
        log.replace('first snapshot');
        await log.flush();
        assert.equal(Number(await redis.hget(liveOutputMetaKey(id), 'epoch')), oldEpoch + 1);
        log.replace('final snapshot');
        await log.close();
        assert.equal(await redis.get(liveOutputKey(id)), 'final snapshot');
        assert.equal(Number(await redis.hget(liveOutputMetaKey(id), 'epoch')), oldEpoch + 1);
    } finally {
        await redis.del(liveOutputKey(id), liveOutputMetaKey(id));
        redis.disconnect();
    }
});

test('a bounded snapshot is published with the origin of the records it dropped', async () => {
    const origins: string[][] = [];
    const redis = {
        on: () => undefined,
        eval: async (_script: string, _keys: number, ...args: string[]) => {
            origins.push(args.slice(9));
            return 0;
        },
    } as unknown as Redis;
    const log = new LiveOutputLog('bounded', { reset: true, redis, transformRecord: record => record.replace(/\u001b\[[0-9;]*m/g, '') });
    log.replace('whole snapshot\n');
    log.replace('{"b":2}\n', { discarded: '\u001b[1m{"a":1}\u001b[0m\nplain\n' });
    await log.close();
    assert.deepEqual(origins, [['0', '0', ''], [String(Buffer.byteLength('{"a":1}\nplain\n')), '1', '{"a":1}']]);
});

test('bounded snapshots start as far into the execution as they dropped, and always move the start', async t => {
    const redis = await connect(t);
    if (!redis) return;
    const id = taskId('bounded');
    try {
        const meta = async () => {
            const { base, start, head, envelopes } = await redis.hgetall(liveOutputMetaKey(id));
            return { base: Number(base), start: Number(start), head, envelopes: Number(envelopes ?? 0) };
        };
        await writeLiveOutput(redis, id, 'abcdef\n', { mode: 'reset' });
        assert.deepEqual(await meta(), { base: 0, start: 0, head: 'abcdef', envelopes: 0 });
        // Dropping as many bytes as the previous snapshot held would repeat its start.
        await writeLiveOutput(redis, id, 'ghij\n', { mode: 'replace', origin: { offset: 7, envelopes: 1, head: '{"first":1}' } });
        assert.deepEqual(await meta(), { base: 8, start: 1, head: '{"first":1}', envelopes: 1 });
        await writeLiveOutput(redis, id, 'klmn\n', { mode: 'replace', origin: { offset: 10, envelopes: 2, head: '{"first":1}' } });
        assert.deepEqual(await meta(), { base: 13, start: 3, head: '{"first":1}', envelopes: 2 });
        await writeLiveOutput(redis, id, 'whole\n', { mode: 'replace' });
        assert.deepEqual(await meta(), { base: 18, start: 18, head: 'whole', envelopes: 0 });
        assert.equal(await redis.get(liveOutputKey(id)), 'whole\n');
    } finally {
        await redis.del(liveOutputKey(id), liveOutputMetaKey(id));
        redis.disconnect();
    }
});

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

for (const reset of [false, true]) {
    test(`failed append batches retain their mode and order across overlapping flushes (reset=${reset})`, async () => {
        const entered = deferred();
        const release = deferred();
        const attempts: Array<{ text: string; mode: string }> = [];
        const redis = {
            eval: async (_script: string, _keys: number, _data: string, _meta: string, text: string, _max: string, _ttl: string, mode: string) => {
                attempts.push({ text, mode });
                if (attempts.length === 1) {
                    entered.resolve();
                    await release.promise;
                    throw new Error('temporary outage');
                }
                return text.length;
            },
        } as unknown as Redis;
        const log = new LiveOutputLog('retry-append', { reset, redis });
        log.append('first\n');
        const first = log.flush();
        await entered.promise;
        log.append('second\n');
        const second = log.flush();
        release.resolve();
        await Promise.all([first, second]);
        await log.close();
        assert.deepEqual(attempts, [
            { text: 'first\n', mode: reset ? 'reset' : 'append' },
            { text: 'first\n', mode: reset ? 'reset' : 'append' },
            { text: 'second\n', mode: 'append' },
        ]);
    });
}

for (const initialFailure of [true, false]) {
    test(`failed snapshots retry before later snapshots (initial failure=${initialFailure})`, async () => {
        const attempts: Array<{ text: string; mode: string }> = [];
        let failing = false;
        const redis = {
            eval: async (_script: string, _keys: number, _data: string, _meta: string, text: string, _max: string, _ttl: string, mode: string) => {
                attempts.push({ text, mode });
                if (failing) throw new Error('temporary outage');
                return text.length;
            },
        } as unknown as Redis;
        const log = new LiveOutputLog('retry-snapshot', { reset: true, redis });
        if (!initialFailure) {
            log.replace('initial');
            await log.flush();
        }
        failing = true;
        log.replace('failed');
        await log.flush();
        const failures = attempts.filter(write => write.text === 'failed');
        assert.ok(failures.length > 0);
        assert.ok(failures.every(write => write.mode === (initialFailure ? 'reset' : 'replace')));
        failing = false;
        const recoveredAt = attempts.length;
        log.replace('later');
        await log.close();
        assert.deepEqual(attempts.slice(recoveredAt), [
            { text: 'failed', mode: initialFailure ? 'reset' : 'replace' },
            { text: 'later', mode: 'replace' },
        ]);
    });
}

test('failed empty reset is retried before output, and a failed close remains retryable', async () => {
    let failing = true;
    const attempts: Array<{ text: string; mode: string }> = [];
    const redis = {
        eval: async (_script: string, _keys: number, _data: string, _meta: string, text: string, _max: string, _ttl: string, mode: string) => {
            attempts.push({ text, mode });
            if (failing) throw new Error('temporary outage');
            return text.length;
        },
    } as unknown as Redis;
    const log = new LiveOutputLog('retry-close', { reset: true, redis });
    await log.flush();
    log.append('final partial');
    await assert.rejects(log.close(), /unpublished/);
    failing = false;
    const recoveredAt = attempts.length;
    await log.close();
    await log.close();
    assert.deepEqual(attempts.slice(recoveredAt), [
        { text: '', mode: 'reset' },
        { text: 'final partial\n', mode: 'append' },
    ]);
});

test('an unchanged snapshot is retried by the timer without another publication', async () => {
    let attempts = 0;
    const published = deferred();
    const redis = {
        eval: async () => {
            if (++attempts === 1) throw new Error('temporary outage');
            published.resolve();
            return 1;
        },
    } as unknown as Redis;
    const log = new LiveOutputLog('timer-retry', { reset: true, redis, flushIntervalMs: 1 });
    // Keep the test alive while the writer's intentionally unreferenced timer runs.
    const timeout = setTimeout(() => published.resolve(), 1000);
    try {
        log.replace('unchanged');
        await published.promise;
        assert.equal(attempts, 2);
    } finally {
        clearTimeout(timeout);
        await log.close();
    }
});

for (const failingSink of ['redis', 'durable']) {
    test(`goal output retains failed ${failingSink} writes and waits for both acknowledgements`, async () => {
        const entered = deferred();
        const release = deferred();
        const published: string[] = [];
        const persisted: string[] = [];
        const attempts = { redis: 0, durable: 0 };
        const write = async (sink: 'redis' | 'durable', text: string) => {
            attempts[sink] += 1;
            if (attempts[sink] === 1) {
                if (sink === failingSink) throw new Error('temporary outage');
                entered.resolve();
                await release.promise;
            }
            (sink === 'redis' ? published : persisted).push(text);
            return text.length;
        };
        const redis = { eval: async (_script: string, _keys: number, _data: string, _meta: string, text: string) => write('redis', text) } as unknown as Redis;
        const output = new LiveAgentOutput('goal-retry', async records => { await write('durable', `${records.join('\n')}\n`); }, 'test', { redis });
        output.append('first\n');
        const first = output.flush();
        await entered.promise;
        output.append('second\n');
        const second = output.flush();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(attempts[failingSink === 'redis' ? 'durable' : 'redis'], 1, 'an in-flight sink is never replayed by another drain');
        assert.equal(attempts[failingSink], 3, 'the independent sink may retry and drain later writes');
        release.resolve();
        await Promise.all([first, second]);
        await output.close();
        assert.deepEqual(published, ['first\n', 'second\n']);
        assert.deepEqual(persisted, published, 'successful sinks are not replayed when the other sink fails');
        assert.equal(attempts[failingSink], 3);
        assert.equal(attempts[failingSink === 'redis' ? 'durable' : 'redis'], 2);
    });
}

test('goal output close retains unacknowledged durable records for retry', async () => {
    let failing = true;
    let publications = 0;
    const persisted: string[] = [];
    const redis = { eval: async () => ++publications } as unknown as Redis;
    const output = new LiveAgentOutput('goal-close', async records => {
        if (failing) throw new Error('temporary outage');
        persisted.push(...records);
    }, 'test', { redis });
    output.append('final\n');
    await assert.rejects(output.close(), /unacknowledged/);
    failing = false;
    await output.close();
    await output.close();
    assert.equal(publications, 1);
    assert.deepEqual(persisted, ['final']);
});

test('a process log refuses output past its unpublished bound and fails its close, keeping accepted output in order', async () => {
    let failing = false;
    const attempts: Array<{ text: string; sequence: string }> = [];
    const redis = {
        eval: async (...args: string[]) => {
            attempts.push({ text: args[4], sequence: args[10] });
            if (failing) throw new Error('temporary outage');
            return args[4].length;
        },
    } as unknown as Redis;
    const overflows: Error[] = [];
    const log = new LiveOutputLog('bounded-backlog', { reset: true, redis, maximumQueuedBytes: 16, onOverflow: error => overflows.push(error) });
    log.append('published\n');
    await log.flush();
    failing = true;
    // Published output no longer counts against the bound.
    log.append('first\n');
    await log.flush();
    log.append('second\n');
    await log.flush();
    assert.deepEqual(overflows, []);
    log.append('third\n');
    log.append('fourth\n');
    log.replace('snapshot');
    assert.equal(overflows.length, 1, 'the overflow is reported once');
    assert.match(overflows[0].message, /fell more than 16 bytes behind/);
    failing = false;
    const recoveredAt = attempts.length;
    await assert.rejects(log.close(), /fell more than 16 bytes behind/, 'refused output fails the close even after the backlog drained');
    await assert.rejects(log.close(), /fell more than 16 bytes behind/);
    assert.deepEqual(attempts.slice(recoveredAt), [{ text: 'first\n', sequence: '2' }, { text: 'second\n', sequence: '3' }], 'accepted batches keep their order and identity');
    assert.ok(attempts.slice(0, recoveredAt).every(attempt => attempt.text !== 'third\n'));
});

test('queued snapshots supersede each other during an outage instead of accumulating', async () => {
    let failing = true;
    const attempts: Array<{ text: string; mode: string }> = [];
    const redis = {
        eval: async (_script: string, _keys: number, _data: string, _meta: string, text: string, _max: string, _ttl: string, mode: string) => {
            attempts.push({ text, mode });
            if (failing) throw new Error('temporary outage');
            return text.length;
        },
    } as unknown as Redis;
    let overflowed = false;
    const log = new LiveOutputLog('bounded-snapshots', { reset: true, redis, maximumQueuedBytes: 20, onOverflow: () => { overflowed = true; } });
    for (let index = 0; index < 50; index += 1) log.replace(`snap ${String(index).padStart(2, '0')}`);
    await log.flush();
    assert.equal(overflowed, false, 'only the in-flight snapshot and the latest one are held');
    failing = false;
    const recoveredAt = attempts.length;
    await log.close();
    assert.deepEqual(attempts.slice(recoveredAt), [{ text: 'snap 00', mode: 'reset' }, { text: 'snap 49', mode: 'replace' }]);
});

for (const failingSink of ['redis', 'durable']) {
    test(`goal output refuses records past its unacknowledged bound while ${failingSink} fails, and keeps the accepted ones`, async () => {
        let failing = true;
        const published: string[] = [];
        const persisted: string[] = [];
        const write = (sink: 'redis' | 'durable', text: string) => {
            if (failing && sink === failingSink) throw new Error('temporary outage');
            (sink === 'redis' ? published : persisted).push(text);
            return text.length;
        };
        const redis = { eval: async (_script: string, _keys: number, _data: string, _meta: string, text: string) => write('redis', text) } as unknown as Redis;
        const overflows: Error[] = [];
        const output = new LiveAgentOutput('goal-bounded', async records => { write('durable', `${records.join('\n')}\n`); }, 'test', {
            redis,
            maximumQueuedBytes: 16,
            onOverflow: error => overflows.push(error),
        });
        output.append('first\n');
        await output.flush();
        output.append('second\n');
        await output.flush();
        assert.deepEqual(overflows, []);
        output.append('third\n');
        output.append('fourth\n');
        assert.equal(overflows.length, failingSink === 'durable' ? 1 : 0, 'only durable overflow fails the session');
        failing = false;
        if (failingSink === 'durable') {
            await assert.rejects(output.close(), /fell more than 16 bytes behind/);
            await assert.rejects(output.close(), /fell more than 16 bytes behind/);
            assert.deepEqual(persisted, ['first\n', 'second\n']);
        } else {
            await output.close();
            await output.close();
            assert.deepEqual(published, ['first\n', 'second\n']);
            assert.equal(persisted.join(''), 'first\nsecond\nthird\nfourth\n', 'Redis overflow cannot discard durable records');
        }
    });
}

for (const kind of ['process', 'goal']) {
    test(`concurrent ${kind} closes share the drain and its bounded retry`, async () => {
        const entered = deferred();
        const release = deferred();
        let attempts = 0;
        const redis = {
            eval: async () => {
                if (++attempts === 1) {
                    entered.resolve();
                    await release.promise;
                    throw new Error('temporary outage');
                }
                return 1;
            },
        } as unknown as Redis;
        const output = kind === 'process'
            ? new LiveOutputLog('concurrent-close', { reset: true, redis })
            : new LiveAgentOutput('concurrent-close', undefined, 'test', { redis });
        output.append('final\n');
        const first = output.close();
        await entered.promise;
        const second = output.close();
        release.resolve();
        const results = await Promise.allSettled([first, second]);
        assert.ok(results.every(result => result.status === 'fulfilled'));
        assert.equal(attempts, 2, 'concurrent shutdown shares the successful retry');
        await output.close();
        assert.equal(attempts, 2);
    });
}

/** Commits each script, then loses the replies of the first `losses` calls, as a connection reset after execution does. */
function losingReplies(redis: Redis, losses: number): Redis {
    let calls = 0;
    return {
        on: () => undefined,
        eval: async (...args: Parameters<Redis['eval']>) => {
            const result = await redis.eval(...args);
            if (++calls <= losses) throw new Error('connection reset before the reply');
            return result;
        },
    } as unknown as Redis;
}

for (const kind of ['process-reset', 'process-append', 'process-snapshot', 'goal'] as const) {
    test(`a committed ${kind} batch whose reply was lost is not applied again on retry`, async t => {
        const redis = await connect(t);
        if (!redis) return;
        const id = taskId(`lost-reply-${kind}`);
        try {
            await writeLiveOutput(redis, id, 'earlier execution\n', { mode: 'reset' });
            const before = await redis.hgetall(liveOutputMetaKey(id));
            const lossy = losingReplies(redis, 1);
            const output = kind === 'goal'
                ? new LiveAgentOutput(id, undefined, 'test', { redis: lossy })
                : new LiveOutputLog(id, { reset: kind !== 'process-append', redis: lossy });
            const publish = (text: string) => (output instanceof LiveOutputLog && kind === 'process-snapshot' ? output.replace(text) : output.append(text));
            publish('first\n');
            await output.flush();
            assert.equal(Number(await redis.hget(liveOutputMetaKey(id), 'epoch')), Number(before.epoch) + (kind === 'process-reset' || kind === 'process-snapshot' ? 1 : 0));
            // The writer saw a rejection, so it retries the same batch before later output.
            publish(kind === 'process-snapshot' ? 'first\nsecond\n' : 'second\n');
            await output.close();
            const expected = kind === 'process-append' || kind === 'goal' ? 'earlier execution\nfirst\nsecond\n' : 'first\nsecond\n';
            assert.equal(await redis.get(liveOutputKey(id)), expected, 'every record is published once');
            const after = await redis.hgetall(liveOutputMetaKey(id));
            assert.equal(after.epoch, String(Number(before.epoch) + (kind === 'process-reset' || kind === 'process-snapshot' ? 1 : 0)), 'a retried reset starts one execution');
            assert.equal(after.generation, before.generation);
            if (kind === 'process-reset') assert.equal(after.base, after.start, 'the retried reset did not move the execution start');
        } finally {
            await redis.del(liveOutputKey(id), liveOutputMetaKey(id));
            redis.disconnect();
        }
    });
}

test('publications of different writers are deduplicated independently', async t => {
    const redis = await connect(t);
    if (!redis) return;
    const id = taskId('writers');
    try {
        await writeLiveOutput(redis, id, 'a1\n', { mode: 'reset', publication: { writer: 'a', sequence: 1 } });
        await writeLiveOutput(redis, id, 'b1\n', { publication: { writer: 'b', sequence: 1 } });
        // A's retry of a committed batch arrives after B's write.
        await writeLiveOutput(redis, id, 'a1\n', { mode: 'reset', publication: { writer: 'a', sequence: 1 } });
        await writeLiveOutput(redis, id, 'a2\n', { publication: { writer: 'a', sequence: 2 } });
        await writeLiveOutput(redis, id, 'unidentified\n');
        await writeLiveOutput(redis, id, 'unidentified\n');
        assert.equal(await redis.get(liveOutputKey(id)), 'a1\nb1\na2\nunidentified\nunidentified\n');
    } finally {
        await redis.del(liveOutputKey(id), liveOutputMetaKey(id));
        redis.disconnect();
    }
});

test('stdout and stderr are framed separately, so a diagnostic never splits a record', async () => {
    const writes: string[] = [];
    const redis = {
        on: () => undefined,
        eval: async (_script: string, _keys: number, _data: string, _meta: string, text: string) => {
            writes.push(text);
            return text.length;
        },
    } as unknown as Redis;
    const log = new LiveOutputLog('sources', { reset: true, redis });
    log.append('{"type":"assistant","message":', 'stdout');
    log.append('warning: slow network\n', 'stderr');
    log.append('{"content":[]}}\n{"type":"res', 'stdout');
    log.append('retrying', 'stderr');
    await log.close();
    assert.deepEqual(writes.join('').split('\n'), [
        'warning: slow network',
        '{"type":"assistant","message":{"content":[]}}',
        // Each source's partial record is flushed on its own at close.
        '{"type":"res',
        'retrying',
        '',
    ]);
});

test('an unfinished record past the maximum is dropped whole and framing resumes at its newline', async () => {
    const writes: string[] = [];
    const redis = {
        on: () => undefined,
        eval: async (_script: string, _keys: number, _data: string, _meta: string, text: string) => {
            writes.push(text);
            return text.length;
        },
    } as unknown as Redis;
    const log = new LiveOutputLog('oversized', { reset: true, redis, maximumRecordBytes: 16 });
    const buffered = () => [...(log as unknown as { partials: Map<string, { text: string }> }).partials.values()]
        .reduce((total, partial) => total + partial.text.length, 0);
    log.append('kept\n{"type":"huge","text":"', 'stdout');
    for (let index = 0; index < 1000; index += 1) {
        log.append('x'.repeat(64), 'stdout');
        assert.ok(buffered() <= 16, 'an unfinished record never buffers past the maximum');
    }
    log.append('warn: unrelated\n', 'stderr');
    log.append('"}\nafter\nexactly sixteen!\nseventeen bytes!!\nlast', 'stdout');
    log.append('y'.repeat(17), 'stderr');
    await log.close();
    assert.deepEqual(writes.join('').split('\n'), [
        'kept',
        'warn: unrelated',
        'after',
        'exactly sixteen!',
        // A partial is flushed on close only when it fits; no fragment of a dropped record is published.
        'last',
        '',
    ]);
});

test('the default maximum bounds the unfinished record of a newline-free stream', async () => {
    const writes: string[] = [];
    const redis = {
        on: () => undefined,
        eval: async (_script: string, _keys: number, _data: string, _meta: string, text: string) => {
            writes.push(text);
            return text.length;
        },
    } as unknown as Redis;
    const log = new LiveOutputLog('oversized-default', { reset: true, redis });
    const partials = (log as unknown as { partials: Map<string, { text: string }> }).partials;
    const chunk = 'z'.repeat(64 * 1024);
    for (let index = 0; index < 64; index += 1) log.append(chunk, 'stdout');
    assert.ok(Buffer.byteLength(partials.get('stdout')!.text) <= 1024 * 1024, '4 MiB without a newline stays bounded');
    log.append('\ndone\n', 'stdout');
    await log.close();
    assert.equal(writes.join(''), 'done\n');
});

for (const durable of [false, true]) {
    test(`agent close tolerates a permanent Redis outage (durable=${durable})`, async () => {
        let attempts = 0;
        const redis = { eval: async () => { attempts++; throw new Error('outage'); } } as unknown as Redis;
        const persisted: string[] = [];
        const output = new LiveAgentOutput('redis-outage', durable ? async records => { persisted.push(...records); } : undefined, 'test', { redis });
        output.append('first\n');
        await output.flush();
        output.append('last\n');
        await output.close();
        assert.ok(attempts >= 3 && attempts <= 5, 'the close drain is bounded');
        assert.deepEqual(persisted, durable ? ['first', 'last'] : []);
    });
}
