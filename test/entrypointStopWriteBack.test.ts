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
const POST_TASK_HELPER = path.join(process.cwd(), 'scripts/privileged-post-task.sh');

// Names of commands the post-task steps used to run, or might be tempted to,
// by bare name. The task runs plant.sh, which puts a program for each in a
// directory that leads PATH and that the task owns (in the image:
// /home/node/bin); each records that it ran. None may run after the task.
const PLANTED = ['cp', 'mv', 'rm', 'mkdir', 'chmod', 'chown', 'find', 'dirname', 'timeout', 'su-exec', 'python3', 'env', 'cat', 'id', 'sh'];
function writePlanter(sandbox: Sandbox): { planter: string; plantedLog: string } {
    const planter = path.join(sandbox.dir, 'plant.sh');
    const plantedLog = path.join(sandbox.dir, 'planted.log');
    fs.writeFileSync(planter, [
        '#!/bin/bash',
        `for name in ${PLANTED.join(' ')}; do`,
        `    printf '#!/bin/bash\necho %s >> %q\nexit 99\n' "$name" ${JSON.stringify(plantedLog)} > ${JSON.stringify(sandbox.bin)}/"$name"`,
        `    /bin/chmod 755 ${JSON.stringify(sandbox.bin)}/"$name"`,
        'done',
    ].join('\n'), { mode: 0o755 });
    return { planter, plantedLog };
}
const plantedRuns = (plantedLog: string) => (fs.existsSync(plantedLog) ? fs.readFileSync(plantedLog, 'utf8').trim().split('\n').filter(Boolean) : []);

type Sandbox = { dir: string; bin: string; home: string; stub(name: string, body: string): void; reset(): void };

function makeSandbox(prefix: string): Sandbox {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const bin = path.join(dir, 'bin');
    const home = path.join(dir, 'container', 'home', 'node');
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(home, 'workspace'), { recursive: true });
    const stub = (name: string, body: string) => fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
    // Removes what a previous task planted and restores the root-faking stubs.
    const reset = () => {
        for (const name of PLANTED) fs.rmSync(path.join(bin, name), { force: true });
        stub('id', 'if [ "$1" = "-u" ]; then echo 0; else exec /usr/bin/id "$@"; fi');
        stub('su-exec', 'shift; exec "$@"');
        stub('chown', 'exit 0');
    };
    reset();
    return { dir, bin, home, stub, reset };
}

function installEntrypoint(sandbox: Sandbox, name: string, replacements: Array<[string, string]>): string {
    let script = fs.readFileSync(path.join(process.cwd(), 'scripts', name), 'utf8');
    for (const [from, to] of replacements) script = script.replaceAll(from, to);
    // Last, so the checkout path survives the /home/node replacement.
    script = script.replaceAll('/opt/propr/privileged-post-task.sh', POST_TASK_HELPER);
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

    async function withOpenCode(body: (ctx: { entrypoint: string; env: NodeJS.ProcessEnv; hostDb: string; ready: string; helperLog: string; plantedLog: string; runtimeData: string; source: string; sandbox: Sandbox }) => Promise<void>): Promise<void> {
        const sandbox = makeSandbox('propr-opencode-stop-');
        const { planter, plantedLog } = writePlanter(sandbox);
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
            // The agent refreshes the ChatGPT token in the disposable DB, plants
            // programs named like the post-task commands, then keeps working.
            sandbox.stub('fake-agent', [
                'cat >/dev/null',
                `python3 -I -B -c 'import sqlite3, sys\nwith sqlite3.connect(sys.argv[1]) as db: db.execute("UPDATE credential SET value=?, time_updated=2 WHERE id=?", (sys.argv[2], "cred-openai"))' "$XDG_DATA_HOME/opencode/opencode.db" ${JSON.stringify(oauth('refresh-2'))}`,
                'if [ -n "${PROPR_TEST_TASK_EXTRA:-}" ]; then eval "$PROPR_TEST_TASK_EXTRA"; fi',
                `/bin/bash ${JSON.stringify(planter)}`,
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
            await body({ entrypoint, env, hostDb, ready, helperLog, plantedLog, runtimeData: path.join(env.XDG_DATA_HOME!, 'opencode'), source, sandbox });
        } finally {
            fs.rmSync(sandbox.dir, { recursive: true, force: true });
        }
    }

    test('a normal exit writes the refreshed token back once and keeps the task status', async () => {
        await withOpenCode(async ({ entrypoint, env, hostDb, ready, helperLog, plantedLog }) => {
            const result = await runEntrypoint(entrypoint, ['fake-agent'], { ...env, PROPR_TEST_EXIT: '7' }, ready);
            assert.equal(result.code, 7, result.stderr);
            assert.equal(hostValue(hostDb), oauth('refresh-2'));
            assert.deepEqual(fs.readFileSync(helperLog, 'utf8').trim().split('\n'), ['seed', 'sync']);
            assert.doesNotMatch(result.stderr, /Warning: could not/);
            assert.deepEqual(plantedRuns(plantedLog), [], 'post-task steps ran programs the task planted on PATH');
        });
    });

    test('copies account.json back as data and refuses one the task replaced with a symlink or hard link', async () => {
        await withOpenCode(async ({ entrypoint, env, ready, plantedLog, runtimeData, source, sandbox }) => {
            const secret = path.join(path.dirname(source), 'not-for-the-host');
            fs.writeFileSync(secret, 'secret');
            fs.writeFileSync(path.join(source, 'account.json'), '{"seeded":true}', { mode: 0o600 });
            // Each run starts from a fresh container: disposable state and PATH as built.
            const run = (extra: string) => {
                sandbox.reset();
                fs.rmSync(runtimeData, { recursive: true, force: true });
                return runEntrypoint(entrypoint, ['fake-agent'], { ...env, PROPR_TEST_TASK_EXTRA: extra }, ready);
            };
            const refreshed = await run(`printf '{"refreshed":true}' > ${JSON.stringify(path.join(runtimeData, 'account.json'))}`);
            assert.equal(refreshed.code, 0, refreshed.stderr);
            assert.equal(fs.readFileSync(path.join(source, 'account.json'), 'utf8'), '{"refreshed":true}');
            assert.equal(fs.statSync(path.join(source, 'account.json')).mode & 0o777, 0o600);
            for (const link of [`ln -sf ${JSON.stringify(secret)}`, `ln -f ${JSON.stringify(secret)}`]) {
                const result = await run(`rm -f ${JSON.stringify(path.join(runtimeData, 'account.json'))}; ${link} ${JSON.stringify(path.join(runtimeData, 'account.json'))}`);
                assert.equal(result.code, 0, result.stderr);
                assert.equal(fs.readFileSync(path.join(source, 'account.json'), 'utf8'), '{"refreshed":true}', `${link}: the host keeps its file`);
                assert.match(result.stderr, /Warning: could not sync refreshed OpenCode credential file account\.json/);
            }
            assert.deepEqual(plantedRuns(plantedLog), []);
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

    // Production topology: the entrypoint runs the opencode-run wrapper, which
    // reads the prompt from stdin and runs `opencode run` as its own child. The
    // signal must reach that child, and the write-back must wait for it to exit.
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        test(`forwards ${signal} through opencode-run to OpenCode before writing back`, async () => {
            await withOpenCode(async ({ entrypoint, env, hostDb, ready, helperLog }) => {
                const bin = env.PATH!.split(':')[0];
                fs.copyFileSync(path.join(process.cwd(), 'scripts/opencode-run.sh'), path.join(bin, 'opencode-run'));
                fs.chmodSync(path.join(bin, 'opencode-run'), 0o755);
                const stub = path.join(bin, 'opencode');
                const realStub = fs.readFileSync(stub, 'utf8').replace('#!/bin/bash\n', '');
                // `opencode run`: check the attached prompt, refresh the token, then work
                // until stopped; logging its exit (after a delay) orders it against sync.
                fs.writeFileSync(stub, [
                    '#!/bin/bash',
                    'if [ "$1" = "run" ]; then',
                    '    prompt=""; while [ $# -gt 0 ]; do if [ "$1" = "--file" ]; then prompt="$2"; fi; shift; done',
                    '    [ "$(cat "$prompt")" = "prompt" ] || exit 9',
                    `    python3 -I -B -c 'import sqlite3, sys\nwith sqlite3.connect(sys.argv[1]) as db: db.execute("UPDATE credential SET value=?, time_updated=2 WHERE id=?", (sys.argv[2], "cred-openai"))' "$XDG_DATA_HOME/opencode/opencode.db" ${JSON.stringify(oauth('refresh-2'))}`,
                    `    stop() { kill "$worker" 2>/dev/null; sleep 0.3; echo agent-stopped >> ${JSON.stringify(helperLog)}; exit "$1"; }`,
                    "    trap 'stop 143' TERM; trap 'stop 130' INT",
                    '    sleep 60 & worker=$!',
                    '    echo $$ > "$PROPR_TEST_HANG"',
                    '    wait "$worker"; exit 0',
                    'fi',
                    realStub,
                ].join('\n'), { mode: 0o755 });
                const tmp = path.join(path.dirname(ready), 'tmp');
                fs.mkdirSync(tmp);
                const result = await runEntrypoint(entrypoint, ['opencode-run', '--format', 'json'], { ...env, PROPR_TEST_HANG: ready, TMPDIR: tmp }, ready, signal);
                assertStopped(result, signal);
                assert.equal(hostValue(hostDb), oauth('refresh-2'));
                assert.deepEqual(fs.readFileSync(helperLog, 'utf8').trim().split('\n'), ['seed', 'agent-stopped', 'sync'], result.stderr);
                assert.deepEqual(fs.readdirSync(tmp), [], 'opencode-run still removes the prompt file');
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

    type AntigravityContext = { entrypoint: string; env: NodeJS.ProcessEnv; hostToken: string; ready: string; plantedLog: string; sandbox: Sandbox };
    async function withAntigravity(body: (ctx: AntigravityContext) => Promise<void>): Promise<void> {
        const sandbox = makeSandbox('propr-agy-stop-');
        const { planter, plantedLog } = writePlanter(sandbox);
        try {
            const source = path.join(sandbox.dir, 'host', '.gemini');
            const hostToken = path.join(source, tokenPath);
            fs.mkdirSync(path.dirname(hostToken), { recursive: true });
            fs.writeFileSync(hostToken, 'token-1', { mode: 0o600 });
            const ready = path.join(sandbox.dir, 'task.pid');
            // agy refreshes its Google token in the disposable HOME, plants
            // programs named like the post-task commands, then keeps working.
            sandbox.stub('fake-agy', [
                'cat >/dev/null',
                `printf token-2 > "$HOME/.gemini/${tokenPath}"`,
                'if [ -n "${PROPR_TEST_TASK_EXTRA:-}" ]; then eval "$PROPR_TEST_TASK_EXTRA"; fi',
                `/bin/bash ${JSON.stringify(planter)}`,
                'if [ -n "${PROPR_TEST_HANG:-}" ]; then echo $$ > "$PROPR_TEST_HANG"; exec /bin/sleep 60; fi',
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
            await body({ entrypoint, env, hostToken, ready, plantedLog, sandbox });
        } finally {
            fs.rmSync(sandbox.dir, { recursive: true, force: true });
        }
    }

    // As ProPR launches it: /bin/bash -lc 'exec agy ...' propr-antigravity, minus the login shell that would reset PATH.
    const command = ['/bin/bash', '-c', 'set -e\nexec fake-agy "$@"', 'propr-antigravity', '--model', 'm'];

    test('a normal exit writes the refreshed token back and keeps the task status', async () => {
        await withAntigravity(async ({ entrypoint, env, hostToken, ready, plantedLog }) => {
            const result = await runEntrypoint(entrypoint, command, { ...env, PROPR_TEST_EXIT: '3' }, ready);
            assert.equal(result.code, 3, result.stderr);
            assert.equal(fs.readFileSync(hostToken, 'utf8'), 'token-2');
            assert.equal(fs.statSync(hostToken).mode & 0o777, 0o600);
            assert.doesNotMatch(result.stderr, /Warning: could not/);
            assert.deepEqual(plantedRuns(plantedLog), [], 'post-task steps ran programs the task planted on PATH');
            assert.deepEqual(fs.readdirSync(path.dirname(hostToken)).filter(name => name.includes('propr-tmp')), [], 'no temp file left behind');
        });
    });

    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        test(`forwards ${signal} to agy and still writes the refreshed token back`, async () => {
            await withAntigravity(async ({ entrypoint, env, hostToken, ready, plantedLog }) => {
                const result = await runEntrypoint(entrypoint, command, { ...env, PROPR_TEST_HANG: ready }, ready, signal);
                assertStopped(result, signal);
                assert.equal(fs.readFileSync(hostToken, 'utf8'), 'token-2');
                assert.equal(fs.statSync(hostToken).mode & 0o777, 0o600);
                assert.deepEqual(plantedRuns(plantedLog), []);
            });
        });
    }

    test('refuses a state file the task replaced with a symlink, and exports the transcript without writing through a planted link', async () => {
        await withAntigravity(async ({ entrypoint, env, hostToken, ready, plantedLog, sandbox }) => {
            const secret = path.join(sandbox.dir, 'not-for-the-host');
            fs.writeFileSync(secret, 'secret');
            const transcriptDir = path.join(sandbox.dir, 'transcript');
            fs.mkdirSync(transcriptDir);
            const transcript = path.join(transcriptDir, 'transcript.jsonl');
            const victim = path.join(sandbox.dir, 'victim');
            fs.writeFileSync(victim, 'untouched');
            const runtimeToken = `"$HOME/.gemini/${tokenPath}"`;
            const logs = '"$HOME/.gemini/antigravity-cli/brain/conversation/.system_generated/logs"';
            const result = await runEntrypoint(entrypoint, command, {
                ...env,
                PROPR_ANTIGRAVITY_TRANSCRIPT_PATH: transcript,
                PROPR_TEST_TASK_EXTRA: [
                    `rm -f ${runtimeToken}; ln -s ${JSON.stringify(secret)} ${runtimeToken}`,
                    `mkdir -p ${logs}; printf '{"step":1}\\n' > ${logs}/transcript.jsonl`,
                    `ln -s ${JSON.stringify(victim)} ${JSON.stringify(transcript)}`,
                ].join('; '),
            }, ready);
            assert.equal(result.code, 0, result.stderr);
            assert.equal(fs.readFileSync(hostToken, 'utf8'), 'token-1', 'the host keeps its token');
            assert.match(result.stderr, /Warning: could not sync refreshed Antigravity state file antigravity-cli\/antigravity-oauth-token/);
            assert.equal(fs.lstatSync(transcript).isFile(), true, 'the planted link is replaced');
            assert.equal(fs.readFileSync(transcript, 'utf8'), '{"step":1}\n');
            assert.equal(fs.statSync(transcript).mode & 0o777, 0o644);
            assert.equal(fs.readFileSync(victim, 'utf8'), 'untouched');
            assert.deepEqual(plantedRuns(plantedLog), []);
        });
    });
});
