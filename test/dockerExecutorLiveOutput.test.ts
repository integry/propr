import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const writes: string[] = [];
let failing = false;
class FakeRedis {
    status = 'ready';
    on() { return this; }
    async eval(_script: string, _keys: number, _data: string, _meta: string, text: string) {
        if (failing) throw new Error('temporary outage');
        writes.push(text);
        return text.length;
    }
    async get() { return null; }
    async quit() { return 'OK'; }
    disconnect() {}
}
mock.module('ioredis', { namedExports: { Redis: FakeRedis, default: FakeRedis } });
const { executeDockerCommand } = await import('../packages/core/src/claude/docker/dockerExecutor.js');
const { runWithActiveRunCostCap } = await import('../packages/core/src/budget/runCostGuardContext.js');
const { RunCostGuard } = await import('../packages/core/src/budget/runCostGuard.js');
const { closeConnection } = await import('../packages/core/src/db/connection.js');

// The pricing import chain opens the SQLite connection, which otherwise keeps the process alive.
after(async () => { await closeConnection(); });

test('a streamed execution publishes stderr diagnostics without splitting an unfinished stdout record', async () => {
    const record = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the code' }] } });
    const script = `
        const wait = ms => new Promise(done => setTimeout(done, ms));
        (async () => {
            process.stdout.write(${JSON.stringify(record.slice(0, 20))});
            await wait(150);
            process.stderr.write('warning: slow network\\n');
            await wait(150);
            process.stdout.write(${JSON.stringify(`${record.slice(20)}\n`)});
        })();`;
    await executeDockerCommand(process.execPath, ['-e', script], { taskId: 'docker-sources', streamToRedis: true, streamStderrToRedis: true, timeout: 10_000 });
    assert.deepEqual(writes.join('').split('\n').filter(Boolean).sort(), [record, 'warning: slow network'].sort());
});

test('a streamed execution drops a newline-free record past the bound instead of buffering it', async () => {
    writes.length = 0;
    const script = `
        const wait = ms => new Promise(done => setTimeout(done, ms));
        (async () => {
            process.stdout.write('before\\n');
            for (let index = 0; index < 48; index += 1) { process.stdout.write('x'.repeat(64 * 1024)); await wait(1); }
            process.stdout.write('\\nafter\\n');
        })();`;
    await executeDockerCommand(process.execPath, ['-e', script], { taskId: 'docker-oversized', streamToRedis: true, timeout: 10_000 });
    assert.deepEqual(writes.join('').split('\n'), ['before', 'after', '']);
});

test('a Redis backlog overflow leaves the running execution successful', async () => {
    failing = true;
    try {
        // Over 16 MiB of complete records, followed by a successful result.
        const script = `
            const record = 'x'.repeat(64 * 1024) + '\\n';
            (async () => {
                for (let index = 0; index < 300; index += 1) {
                    if (!process.stdout.write(record)) await new Promise(done => process.stdout.once('drain', done));
                }
                process.stdout.write('finished\\n');
            })();`;
        const result = await executeDockerCommand(process.execPath, ['-e', script], { taskId: 'docker-backlog', streamToRedis: true, timeout: 10_000 });
        assert.equal(result.exitCode, 0);
        assert.match(result.stdout, /finished/);
    } finally {
        failing = false;
    }
});

test('an agent that crosses its spend cap and exits before the next check ends with the spend-cap outcome', async () => {
    const usage = JSON.stringify({ type: 'assistant', message: { id: 'a', usage: { output_tokens: 5000 } } });
    // A stand-in `docker` that streams its last usage without a trailing newline and exits.
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-fake-docker-'));
    fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\nprintf '%s' '${usage}'\n`, { mode: 0o755 });
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
    const observed: string[] = [];
    const events: string[] = [];
    const guard = {
        taskId: 'docker-cost-cap', exceeded: false,
        beginExecution: () => ({
            observeLine: (line: string) => { observed.push(line); },
            finish: async () => {
                events.push(`finish after ${observed.length} line(s)`);
                await new Promise(done => setTimeout(done, 20));
                return 'run spend cap of $1.00 exceeded';
            },
        }),
    };
    try {
        const run = (preserveOutputOnTimeout: boolean) => runWithActiveRunCostCap(guard, () =>
            executeDockerCommand('docker', ['run', '--rm', 'agent-image'], { timeout: 10_000, preserveOutputOnTimeout }));
        const result = await run(true);
        assert.deepEqual(events, ['finish after 1 line(s)'], 'the final, unterminated record is observed before the final evaluation');
        assert.deepEqual(observed, [usage]);
        assert.equal(result.costCapExceeded, true);
        assert.match(result.stderr, /run spend cap of \$1\.00 exceeded/);
        assert.equal(result.stdout, usage);
        await assert.rejects(run(false), { name: 'RunCostCapExceededError' });
    } finally {
        process.env.PATH = originalPath;
        fs.rmSync(bin, { recursive: true, force: true });
    }
});

test('an agent on its default model is priced with the model it was started with when its usage names none', async () => {
    const turn = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 3000 } });
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-fake-docker-'));
    fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\nprintf '%s\\n' '${turn}'\n`, { mode: 0o755 });
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
    const priced: string[] = [];
    // A PR job without an explicit `llm` gives the guard no default model.
    const guard = new RunCostGuard({
        taskId: 'docker-default-model', inputs: { override: 2 },
        readRecordedSpend: async () => 0,
        priceUsage: async (model, totals) => { priced.push(model); return totals.outputTokens / 1000; },
        checkIntervalMs: 60_000,
    });
    try {
        await guard.start();
        const result = await runWithActiveRunCostCap(guard, () =>
            executeDockerCommand('docker', ['run', '--rm', 'agent-image'], { timeout: 10_000, preserveOutputOnTimeout: true, model: 'gpt-5-codex' }));
        assert.equal(result.costCapExceeded, true);
        assert.match(result.stderr, /run spend cap of \$2\.00 exceeded/);
        assert.ok(priced.length > 0 && priced.every(model => model === 'gpt-5-codex'));
        assert.equal(guard.exceededWith?.spentUsd, 3);
    } finally {
        guard.close();
        process.env.PATH = originalPath;
        fs.rmSync(bin, { recursive: true, force: true });
    }
});

test('a run stopped at its spend cap refuses later implementation and analysis containers before they start', async () => {
    const usage = JSON.stringify({ type: 'assistant', message: { id: 'a', usage: { output_tokens: 3000 } } });
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-fake-docker-'));
    const launches = path.join(bin, 'launches');
    // Records every container it starts, then streams usage worth $3.
    fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\nfor arg; do image="$arg"; done\necho "$image" >> '${launches}'\nprintf '%s\\n' '${usage}'\n`, { mode: 0o755 });
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
    const guard = new RunCostGuard({
        taskId: 'docker-refused-after-cap', inputs: { override: 2 }, defaultModel: 'claude-sonnet-4',
        readRecordedSpend: async () => 0,
        priceUsage: async (_model, totals) => totals.outputTokens / 1000,
        checkIntervalMs: 60_000,
    });
    const run = (image: string, preserveOutputOnTimeout: boolean, costCapExempt?: boolean) => runWithActiveRunCostCap(guard, () =>
        executeDockerCommand('docker', ['run', '--rm', image], { timeout: 10_000, preserveOutputOnTimeout, ...(costCapExempt ? { costCapExempt } : {}) }));
    const launched = () => fs.existsSync(launches) ? fs.readFileSync(launches, 'utf8').split('\n').filter(Boolean) : [];
    try {
        await guard.start();
        const first = await run('implementation', true);
        assert.equal(first.costCapExceeded, true);
        assert.equal(guard.exceeded, true);

        const implementation = await run('implementation-again', true);
        assert.equal(implementation.costCapExceeded, true, 'a later implementation ends with the spend-cap outcome');
        assert.equal(implementation.stdout, '');
        assert.match(implementation.stderr, /run spend cap of \$2\.00 exceeded/);
        await assert.rejects(run('analysis', false), { name: 'RunCostCapExceededError' });
        assert.deepEqual(launched(), ['implementation'], 'no agent container starts after the cap stop');

        // A container that runs no agent (a usage probe) is not refused.
        const probe = await run('usage-probe', false, true);
        assert.equal(probe.exitCode, 0);
        assert.deepEqual(launched(), ['implementation', 'usage-probe']);
        assert.equal(guard.exceededWith?.spentUsd, 3, 'the exempt probe is not counted toward the run');
    } finally {
        guard.close();
        process.env.PATH = originalPath;
        fs.rmSync(bin, { recursive: true, force: true });
    }
});
