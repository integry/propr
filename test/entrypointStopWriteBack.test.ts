import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ProPR stops task containers (cancel, cost cap, watchdog, deadline) with
// `docker stop`, and docker --init signals only the entrypoint shell. The
// OpenCode and Antigravity entrypoints must forward that signal to the agent,
// wait for it, and still write a refreshed OAuth token back to the host store
// exactly once. These tests run the real scripts as root would (id/su-exec/
// chown stubbed) against a sandbox standing in for the container filesystem.

const credentialsScript = path.join(process.cwd(), 'scripts/opencode-credentials.py');

type Sandbox = { dir: string; bin: string; home: string; stub(name: string, body: string): void };

function makeSandbox(prefix: string): Sandbox {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const bin = path.join(dir, 'bin');
    const home = path.join(dir, 'container', 'home', 'node');
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(home, 'workspace'), { recursive: true });
    const stub = (name: string, body: string) => fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
    stub('id', 'if [ "$1" = "-u" ]; then echo 0; else exec /usr/bin/id "$@"; fi');
    stub('su-exec', 'shift; exec "$@"');
    stub('chown', 'exit 0');
    return { dir, bin, home, stub };
}

function installEntrypoint(sandbox: Sandbox, name: string, replacements: Array<[string, string]>): string {
    let script = fs.readFileSync(path.join(process.cwd(), 'scripts', name), 'utf8');
    for (const [from, to] of replacements) script = script.replaceAll(from, to);
    const entrypoint = path.join(sandbox.dir, name);
    fs.writeFileSync(entrypoint, script, { mode: 0o755 });
    return entrypoint;
}

type RunResult = { code: number | null; stderr: string; stopSeconds?: number; taskPid?: number };

/** Runs the entrypoint; with `signal`, sends it once the task reports it has refreshed and is still working. */
async function runEntrypoint(entrypoint: string, args: string[], env: NodeJS.ProcessEnv, ready: string, signal?: NodeJS.Signals): Promise<RunResult> {
    const child = spawn('/bin/bash', [entrypoint, ...args], { env, stdio: ['pipe', 'ignore', 'pipe'] });
    child.stdin.end('prompt');
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    const exited = new Promise<number | null>(resolve => { child.on('exit', code => resolve(code)); });
    if (!signal) return { code: await exited, stderr };
    const deadline = Date.now() + 20_000;
    while (!(fs.existsSync(ready) && fs.readFileSync(ready, 'utf8').trim())) {
        assert.ok(Date.now() < deadline, `task never started: ${stderr}`);
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    const taskPid = Number(fs.readFileSync(ready, 'utf8').trim());
    const stoppedAt = Date.now();
    child.kill(signal);
    const code = await Promise.race([exited, new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 20_000))]);
    if (code === 'timeout') {
        child.kill('SIGKILL');
        assert.fail(`entrypoint did not exit after ${signal}: ${stderr}`);
    }
    return { code, stderr, stopSeconds: (Date.now() - stoppedAt) / 1000, taskPid };
}

function assertStopped(result: RunResult, signal: NodeJS.Signals): void {
    assert.equal(result.code, signal === 'SIGTERM' ? 143 : 130, result.stderr);
    assert.ok(result.stopSeconds! < 5, `stopped in ${result.stopSeconds}s, not within a few seconds`);
    assert.throws(() => process.kill(result.taskPid!, 0), `the task was stopped, not orphaned: ${result.stderr}`);
}

describe('opencode-entrypoint.sh stop handling', () => {
    const opencode2Tables = 'CREATE TABLE migration (id TEXT PRIMARY KEY); CREATE TABLE session_v2 (id TEXT PRIMARY KEY); CREATE TABLE machine (id TEXT PRIMARY KEY)';
    // One line: it is embedded in a stub script as a double-quoted argument.
    const credentialTable = 'CREATE TABLE IF NOT EXISTS credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT, '
        + 'connector_id TEXT, method_id TEXT, active INTEGER, time_created INTEGER, time_updated INTEGER)';
    const oauth = (refresh: string) => JSON.stringify({ type: 'oauth', methodID: 'oauth', refresh, access: `access-${refresh}`, expires: 1 });
    const sql = (db: string, script: string) => execFileSync('python3', ['-I', '-B', '-c', 'import sqlite3, sys\nwith sqlite3.connect(sys.argv[1]) as db: db.executescript(sys.argv[2])', db, script]);
    const hostValue = (db: string) => execFileSync('python3', ['-I', '-B', '-c', 'import sqlite3, sys\nprint(sqlite3.connect(sys.argv[1]).execute("SELECT value FROM credential WHERE id=\'cred-openai\'").fetchone()[0])', db], { encoding: 'utf8' }).trim();

    async function withOpenCode(body: (ctx: { entrypoint: string; env: NodeJS.ProcessEnv; hostDb: string; ready: string; helperLog: string }) => Promise<void>): Promise<void> {
        const sandbox = makeSandbox('propr-opencode-stop-');
        try {
            const source = path.join(sandbox.dir, 'host', 'opencode');
            fs.mkdirSync(source, { recursive: true });
            const hostDb = path.join(source, 'opencode.db');
            sql(hostDb, `${opencode2Tables}; ${credentialTable};
                INSERT INTO credential VALUES ('cred-openai', 'openai', 'ChatGPT', '${oauth('refresh-1')}', NULL, 'oauth', 1, 1, 1);`);
            const helperLog = path.join(sandbox.dir, 'helper.log');
            const helper = path.join(sandbox.dir, 'opencode-credentials.py');
            fs.writeFileSync(helper, [
                'import runpy, sys',
                `with open(${JSON.stringify(helperLog)}, "a") as log: log.write(sys.argv[1] + "\\n")`,
                `sys.argv[0] = ${JSON.stringify(credentialsScript)}`,
                `runpy.run_path(${JSON.stringify(credentialsScript)}, run_name="__main__")`,
            ].join('\n'));
            // OpenCode 2.x: --version, and `auth list --standalone` creates the disposable schema.
            sandbox.stub('opencode', [
                'if [ "$1" = "--version" ]; then echo "opencode v2.4.2"; exit 0; fi',
                `python3 -I -B -c 'import sqlite3, sys\nwith sqlite3.connect(sys.argv[1]) as db: db.executescript(sys.argv[2])' "$XDG_DATA_HOME/opencode/opencode.db" ${JSON.stringify(credentialTable)}`,
            ].join('\n'));
            const ready = path.join(sandbox.dir, 'task.pid');
            // The agent refreshes the ChatGPT token in the disposable DB, then keeps working.
            sandbox.stub('fake-agent', [
                'cat >/dev/null',
                `python3 -I -B -c 'import sqlite3, sys\nwith sqlite3.connect(sys.argv[1]) as db: db.execute("UPDATE credential SET value=?, time_updated=2 WHERE id=?", (sys.argv[2], "cred-openai"))' "$XDG_DATA_HOME/opencode/opencode.db" ${JSON.stringify(oauth('refresh-2'))}`,
                'if [ -n "${PROPR_TEST_HANG:-}" ]; then echo $$ > "$PROPR_TEST_HANG"; exec sleep 60; fi',
                'exit "${PROPR_TEST_EXIT:-0}"',
            ].join('\n'));
            const entrypoint = installEntrypoint(sandbox, 'opencode-entrypoint.sh', [['/home/node', sandbox.home]]);
            const env: NodeJS.ProcessEnv = {
                PATH: `${sandbox.bin}:${process.env.PATH}`,
                HOME: sandbox.home,
                OPENCODE_CONFIG_DIR: path.join(sandbox.home, '.config', 'opencode'),
                XDG_DATA_HOME: path.join(sandbox.dir, 'container', 'tmp', 'propr-opencode-data'),
                XDG_STATE_HOME: path.join(sandbox.dir, 'container', 'tmp', 'propr-opencode-state'),
                PROPR_EPHEMERAL_STATE: '1',
                PROPR_OPENCODE_SOURCE_DATA: source,
                PROPR_OPENCODE_CREDENTIALS_HELPER: helper,
                PYTHONDONTWRITEBYTECODE: '1',
            };
            await body({ entrypoint, env, hostDb, ready, helperLog });
        } finally {
            fs.rmSync(sandbox.dir, { recursive: true, force: true });
        }
    }

    test('a normal exit writes the refreshed token back once and keeps the task status', async () => {
        await withOpenCode(async ({ entrypoint, env, hostDb, ready, helperLog }) => {
            const result = await runEntrypoint(entrypoint, ['fake-agent'], { ...env, PROPR_TEST_EXIT: '7' }, ready);
            assert.equal(result.code, 7, result.stderr);
            assert.equal(hostValue(hostDb), oauth('refresh-2'));
            assert.deepEqual(fs.readFileSync(helperLog, 'utf8').trim().split('\n'), ['seed', 'sync']);
            assert.doesNotMatch(result.stderr, /Warning: could not/);
        });
    });

    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        test(`forwards ${signal} to the agent and still writes the refreshed token back once`, async () => {
            await withOpenCode(async ({ entrypoint, env, hostDb, ready, helperLog }) => {
                const result = await runEntrypoint(entrypoint, ['fake-agent'], { ...env, PROPR_TEST_HANG: ready }, ready, signal);
                assertStopped(result, signal);
                assert.equal(hostValue(hostDb), oauth('refresh-2'));
                assert.deepEqual(fs.readFileSync(helperLog, 'utf8').trim().split('\n'), ['seed', 'sync']);
            });
        });
    }

    test('a stalled write-back is bounded and reported instead of outliving the stop timeout', async () => {
        await withOpenCode(async ({ entrypoint, env, ready }) => {
            const stalled = path.join(path.dirname(ready), 'stalled-helper.py');
            fs.writeFileSync(stalled, 'import sys, time\nif sys.argv[1] == "sync": time.sleep(30)\n');
            const result = await runEntrypoint(entrypoint, ['fake-agent'], {
                ...env, PROPR_TEST_HANG: ready, PROPR_OPENCODE_CREDENTIALS_HELPER: stalled, PROPR_CREDENTIAL_WRITE_BACK_TIMEOUT: '1',
            }, ready, 'SIGTERM');
            assertStopped(result, 'SIGTERM');
            assert.match(result.stderr, /Warning: could not write refreshed OpenCode credentials back/);
        });
    });
});

describe('antigravity-entrypoint.sh stop handling', () => {
    const tokenPath = path.join('antigravity-cli', 'antigravity-oauth-token');

    async function withAntigravity(body: (ctx: { entrypoint: string; env: NodeJS.ProcessEnv; hostToken: string; ready: string; mvLog: string }) => Promise<void>): Promise<void> {
        const sandbox = makeSandbox('propr-agy-stop-');
        try {
            const source = path.join(sandbox.dir, 'host', '.gemini');
            const hostToken = path.join(source, tokenPath);
            fs.mkdirSync(path.dirname(hostToken), { recursive: true });
            fs.writeFileSync(hostToken, 'token-1', { mode: 0o600 });
            // mv is used only by the write-back: count how often it replaces the host token.
            const mvLog = path.join(sandbox.dir, 'mv.log');
            sandbox.stub('mv', `printf '%s\\n' "\${@: -1}" >> ${JSON.stringify(mvLog)}\nexec /bin/mv "$@"`);
            const ready = path.join(sandbox.dir, 'task.pid');
            // agy refreshes its Google token in the disposable HOME, then keeps working.
            sandbox.stub('fake-agy', [
                'cat >/dev/null',
                `printf token-2 > "$HOME/.gemini/${tokenPath}"`,
                'if [ -n "${PROPR_TEST_HANG:-}" ]; then echo $$ > "$PROPR_TEST_HANG"; exec sleep 60; fi',
                'exit "${PROPR_TEST_EXIT:-0}"',
            ].join('\n'));
            const runtimeHome = path.join(sandbox.dir, 'container', 'tmp', 'propr-antigravity-home');
            const entrypoint = installEntrypoint(sandbox, 'antigravity-entrypoint.sh', [
                ['/tmp/propr-antigravity-home', runtimeHome],
                ['/home/node', sandbox.home],
            ]);
            const env: NodeJS.ProcessEnv = {
                PATH: `${sandbox.bin}:${process.env.PATH}`,
                HOME: sandbox.home,
                GH_TOKEN: 'test-token',
                PROPR_EPHEMERAL_STATE: '1',
                PROPR_ANTIGRAVITY_SOURCE_CONFIG: source,
            };
            await body({ entrypoint, env, hostToken, ready, mvLog });
        } finally {
            fs.rmSync(sandbox.dir, { recursive: true, force: true });
        }
    }

    // As ProPR launches it: /bin/bash -lc 'exec agy ...' propr-antigravity, minus the login shell that would reset PATH.
    const command = ['/bin/bash', '-c', 'set -e\nexec fake-agy "$@"', 'propr-antigravity', '--model', 'm'];
    const tokenWrites = (mvLog: string, hostToken: string) => fs.readFileSync(mvLog, 'utf8').trim().split('\n').filter(target => target === hostToken).length;

    test('a normal exit writes the refreshed token back once and keeps the task status', async () => {
        await withAntigravity(async ({ entrypoint, env, hostToken, ready, mvLog }) => {
            const result = await runEntrypoint(entrypoint, command, { ...env, PROPR_TEST_EXIT: '3' }, ready);
            assert.equal(result.code, 3, result.stderr);
            assert.equal(fs.readFileSync(hostToken, 'utf8'), 'token-2');
            assert.equal(tokenWrites(mvLog, hostToken), 1);
        });
    });

    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        test(`forwards ${signal} to agy and still writes the refreshed token back once`, async () => {
            await withAntigravity(async ({ entrypoint, env, hostToken, ready, mvLog }) => {
                const result = await runEntrypoint(entrypoint, command, { ...env, PROPR_TEST_HANG: ready }, ready, signal);
                assertStopped(result, signal);
                assert.equal(fs.readFileSync(hostToken, 'utf8'), 'token-2');
                assert.equal(tokenWrites(mvLog, hostToken), 1);
                assert.equal(fs.statSync(hostToken).mode & 0o777, 0o600);
            });
        });
    }
});
