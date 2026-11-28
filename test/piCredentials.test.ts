import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const credentialsScript = path.join(process.cwd(), 'scripts/pi-credentials.py');

type AuthEntry = Record<string, unknown>;
type Auth = Record<string, AuthEntry>;

// -B keeps scripts/__pycache__ out of the checkout when the observer imports
// the helper; -I ignores PYTHON* variables, so PYTHONDONTWRITEBYTECODE would not.
function runPython(args: string[], options: { input?: string } = {}): string {
    return execFileSync('python3', ['-I', '-B', ...args], { encoding: 'utf8', ...options });
}

function runCredentials(...args: string[]): string {
    return runPython([credentialsScript, ...args]);
}

const oauth = (suffix: string, extra: AuthEntry = {}): AuthEntry => ({
    type: 'oauth', access: `access-${suffix}`, refresh: `refresh-${suffix}`, expires: Number(suffix.replace(/\D/g, '') || 1), ...extra
});

const hostAuth = (): Auth => ({
    anthropic: oauth('1', { scopes: ['user:inference'] }),
    'openai-codex': oauth('10', { accountId: 'acct' }),
    openrouter: { type: 'api_key', key: 'router-key' }
});

interface Run {
    dir: string;
    host: string;
    runtime: string;
    snapshot: string;
    readHost(): Auth;
    writeRuntime(auth: Auth): void;
    writeHost(auth: Auth): void;
    seed(): void;
    sync(): string;
}

/** One container run: the entrypoint copies auth.json, seed records it, Pi runs, then sync. */
function withRun(initial: Auth | null, body: (run: Run) => void, mode = 0o600): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-credentials-'));
    try {
        const sourceDir = path.join(dir, 'source');
        const runtimeDir = path.join(dir, 'runtime', 'agent');
        fs.mkdirSync(sourceDir);
        fs.mkdirSync(runtimeDir, { recursive: true });
        const host = path.join(sourceDir, 'auth.json');
        const runtime = path.join(runtimeDir, 'auth.json');
        const snapshot = path.join(dir, 'runtime', 'propr-seeded-auth.json');
        if (initial) {
            fs.writeFileSync(host, JSON.stringify(initial, null, 2), { mode });
            fs.chmodSync(host, mode);
            fs.copyFileSync(host, runtime);
        }
        body({
            dir, host, runtime, snapshot,
            readHost: () => JSON.parse(fs.readFileSync(host, 'utf8')) as Auth,
            writeRuntime: auth => fs.writeFileSync(runtime, JSON.stringify(auth)),
            writeHost: auth => fs.writeFileSync(host, JSON.stringify(auth, null, 2)),
            seed: () => { runCredentials('seed', runtime, snapshot); },
            sync: () => runCredentials('sync', host, runtime, snapshot),
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

describe('pi-credentials.py', () => {
    test('seed records the imported auth.json in an owner-only snapshot', () => {
        withRun(hostAuth(), run => {
            run.seed();
            assert.deepEqual(JSON.parse(fs.readFileSync(run.snapshot, 'utf8')), hostAuth());
            assert.equal(fs.statSync(run.snapshot).mode & 0o777, 0o600);
        });
    });

    test('writes nothing when no OAuth entry changed', () => {
        withRun(hostAuth(), run => {
            run.seed();
            const before = fs.readFileSync(run.host);
            const { ino, mtimeMs } = fs.statSync(run.host);
            // Pi rewrites auth.json in its own layout even without a refresh.
            run.writeRuntime(hostAuth());
            assert.equal(run.sync(), '');
            assert.deepEqual(fs.readFileSync(run.host), before);
            assert.equal(fs.statSync(run.host).ino, ino);
            assert.equal(fs.statSync(run.host).mtimeMs, mtimeMs);
            assert.deepEqual(fs.readdirSync(path.dirname(run.host)), ['auth.json']);
        });
    });

    test('writes a refreshed OAuth entry back and leaves every other entry as the host has it', () => {
        withRun(hostAuth(), run => {
            run.seed();
            const refreshed = oauth('2', { scopes: ['user:inference'] });
            run.writeRuntime({ ...hostAuth(), anthropic: refreshed });
            run.sync();
            assert.deepEqual(run.readHost(), { ...hostAuth(), anthropic: refreshed });
            // Pi's own layout: JSON.stringify(data, null, 2).
            assert.equal(fs.readFileSync(run.host, 'utf8'), JSON.stringify({ ...hostAuth(), anthropic: refreshed }, null, 2));
            assert.deepEqual(fs.readdirSync(path.dirname(run.host)), ['auth.json'], 'no temp file or lock is left behind');
        });
    });

    test('keeps the original file mode', () => {
        for (const mode of [0o600, 0o640]) {
            withRun(hostAuth(), run => {
                run.seed();
                run.writeRuntime({ ...hostAuth(), anthropic: oauth('2') });
                run.sync();
                assert.equal(fs.statSync(run.host).mode & 0o7777, mode);
                assert.deepEqual(run.readHost().anthropic, oauth('2'));
            }, mode);
        }
    });

    test('refuses to write through a symlinked host auth.json', () => {
        withRun(hostAuth(), run => {
            const store = path.join(run.dir, 'store');
            fs.mkdirSync(store);
            const target = path.join(store, 'pi-auth.json');
            fs.renameSync(run.host, target);
            fs.symlinkSync(target, run.host);
            run.seed();
            run.writeRuntime({ ...hostAuth(), anthropic: oauth('2') });
            run.sync();
            assert.ok(fs.lstatSync(run.host).isSymbolicLink(), 'the link is left alone');
            assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), hostAuth(), 'the link target is never written');
            assert.deepEqual(fs.readdirSync(store), ['pi-auth.json']);
            assert.deepEqual(fs.readdirSync(path.dirname(run.host)), ['auth.json'], 'no lock or temp file is created');
        });
    });

    test('reads task-written auth.json only as size-limited, unfollowed JSON objects', () => {
        withRun(hostAuth(), run => {
            run.seed();
            const outside = path.join(run.dir, 'outside.json');
            fs.writeFileSync(outside, JSON.stringify({ ...hostAuth(), anthropic: oauth('2') }));
            fs.rmSync(run.runtime);
            fs.symlinkSync(outside, run.runtime);
            run.sync();
            assert.deepEqual(run.readHost(), hostAuth(), 'a symlinked runtime auth.json is not followed');

            for (const content of ['[1,2]', '"text"', '{"anthropic":', JSON.stringify({ ...hostAuth(), anthropic: oauth('2', { pad: 'x'.repeat(1024 * 1024) }) })]) {
                fs.rmSync(run.runtime);
                fs.writeFileSync(run.runtime, content);
                run.sync();
                assert.deepEqual(run.readHost(), hostAuth(), `${content.slice(0, 20)} is not written back`);
            }
            assert.equal(runCredentials('seed', run.runtime, '-').trim(), 'null', 'an oversized runtime file reads as no data');
        });
    });

    test('sync-from-stdin rejects records that are not JSON objects or are oversized', () => {
        withRun(hostAuth(), run => {
            const dirFd = fs.openSync(path.dirname(run.host), 'r');
            try {
                const refreshed = JSON.stringify({ ...hostAuth(), anthropic: oauth('2') });
                const records = [
                    `${JSON.stringify(hostAuth())}\n[]\n`,
                    `null\n${refreshed}\n`,
                    `${JSON.stringify(hostAuth())}\n${JSON.stringify({ ...hostAuth(), anthropic: oauth('2', { pad: 'x'.repeat(6 * 1024 * 1024 + 8) }) })}\n`,
                    `${JSON.stringify(hostAuth())}\n`,
                    '',
                ];
                for (const input of records) {
                    const result = spawnSync('python3', ['-I', '-B', credentialsScript, 'sync-from-stdin', run.host, 'auth.json'], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', dirFd] });
                    assert.equal(result.status, 0, result.stderr);
                    assert.deepEqual(run.readHost(), hostAuth(), `nothing written for ${input.slice(0, 40)}`);
                }
                const ok = spawnSync('python3', ['-I', '-B', credentialsScript, 'sync-from-stdin', run.host, 'auth.json'], {
                    input: `${JSON.stringify(hostAuth())}\n${refreshed}\n`, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', dirFd],
                });
                assert.equal(ok.status, 0, ok.stderr);
                assert.deepEqual(run.readHost().anthropic, oauth('2'), 'a valid pair is written back through the pinned dir');
            } finally {
                fs.closeSync(dirFd);
            }
        });
    });

    test('write-back to a foreign-owned source (0700 dir, 0600 file) keeps owner, group and mode without recursive chown', () => {
        // Unprivileged stand-in for the root writer: the host file reports an
        // owner other than the test process (1001, or 1002 when the runner
        // itself is 1001, as on GitHub Actions), and every ownership call is
        // recorded instead of made. The Docker smoke test exercises the same
        // case for real as root.
        const foreignId = process.getuid?.() === 1001 || process.getgid?.() === 1001 ? 1002 : 1001;
        const observer = `
import importlib.util, json, os, stat, sys
script, log, foreign, argv = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4:]
spec = importlib.util.spec_from_file_location("pi_credentials", script)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
calls = []
real_read, real_fstat = helper.read_json_with_metadata, os.fstat
def read_as_foreign(path):
    auth, metadata = real_read(path)
    if metadata is None or os.path.basename(os.fspath(path)) != "auth.json":
        return auth, metadata
    fake = list(metadata)
    fake[stat.ST_UID], fake[stat.ST_GID] = foreign, foreign
    return auth, os.stat_result(fake)
helper.read_json_with_metadata = read_as_foreign
os.fchown = lambda fd, uid, gid: calls.append(["fchown", os.readlink(f"/proc/self/fd/{fd}"), uid, gid])
os.chown = lambda *a, **k: calls.append(["chown", *map(str, a)])
os.lchown = lambda *a, **k: calls.append(["lchown", *map(str, a)])
real_replace = os.replace
os.replace = lambda src, dst: (calls.append(["replace", os.path.dirname(src) == os.path.dirname(dst), stat.S_IMODE(os.lstat(src).st_mode)]), real_replace(src, dst))[1]
code = helper.main(argv)
open(log, "w").write(json.dumps(calls))
sys.exit(code)
`;
        withRun(hostAuth(), run => {
            const sourceDir = path.dirname(run.host);
            fs.chmodSync(sourceDir, 0o700);
            run.seed();
            run.writeRuntime({ ...hostAuth(), anthropic: oauth('2') });
            const log = path.join(run.dir, 'calls.json');
            runPython(['-c', observer, credentialsScript, log, String(foreignId), 'sync', run.host, run.runtime, run.snapshot]);
            const calls = JSON.parse(fs.readFileSync(log, 'utf8')) as unknown[][];
            const chowns = calls.filter(call => call[0] !== 'replace');
            assert.equal(chowns.length, 1, `exactly one ownership change: ${JSON.stringify(calls)}`);
            assert.equal(chowns[0][0], 'fchown', 'ownership is set on the temp file descriptor, never by path or recursively');
            assert.match(String(chowns[0][1]), /auth\.json\.propr-tmp-/);
            assert.deepEqual(chowns[0].slice(2), [foreignId, foreignId]);
            assert.deepEqual(calls.at(-1), ['replace', true, 0o600], 'replaced from the same dir with the original mode');
            assert.equal(fs.statSync(run.host).mode & 0o7777, 0o600);
            assert.equal(fs.statSync(sourceDir).mode & 0o7777, 0o700, 'the source dir mode is untouched');
            assert.deepEqual(run.readHost().anthropic, oauth('2'));
            assert.deepEqual(fs.readdirSync(sourceDir), ['auth.json']);
        }, 0o600);
    });

    test('a host login during the run wins over the runtime refresh', () => {
        withRun(hostAuth(), run => {
            run.seed();
            const hostLogin = oauth('77', { scopes: ['user:inference'] });
            run.writeHost({ ...hostAuth(), anthropic: hostLogin });
            run.writeRuntime({ ...hostAuth(), anthropic: oauth('2'), 'openai-codex': oauth('20', { accountId: 'acct' }) });
            run.sync();
            // Per entry: the untouched host entry still takes the refresh.
            assert.deepEqual(run.readHost(), { ...hostAuth(), anthropic: hostLogin, 'openai-codex': oauth('20', { accountId: 'acct' }) });
        });
    });

    test('a host logout during the run is not undone', () => {
        withRun(hostAuth(), run => {
            run.seed();
            const { anthropic: _loggedOut, ...remaining } = hostAuth();
            run.writeHost(remaining);
            run.writeRuntime({ ...hostAuth(), anthropic: oauth('2') });
            const before = fs.readFileSync(run.host);
            run.sync();
            assert.deepEqual(fs.readFileSync(run.host), before);
        });
    });

    test('never rewrites API-key entries or adds providers the host did not have', () => {
        withRun(hostAuth(), run => {
            run.seed();
            run.writeRuntime({
                ...hostAuth(),
                openrouter: { type: 'api_key', key: 'rotated-in-container' },
                xai: oauth('5'),
            });
            const before = fs.readFileSync(run.host);
            run.sync();
            assert.deepEqual(fs.readFileSync(run.host), before);
        });
    });

    test('does not turn an API-key entry into OAuth', () => {
        withRun(hostAuth(), run => {
            run.seed();
            run.writeRuntime({ ...hostAuth(), openrouter: oauth('9') });
            const before = fs.readFileSync(run.host);
            run.sync();
            assert.deepEqual(fs.readFileSync(run.host), before);
        });
    });

    test('ignores runtime entries Pi removed', () => {
        withRun(hostAuth(), run => {
            run.seed();
            run.writeRuntime({ openrouter: { type: 'api_key', key: 'router-key' } });
            const before = fs.readFileSync(run.host);
            run.sync();
            assert.deepEqual(fs.readFileSync(run.host), before);
        });
    });

    test('does nothing without a seed snapshot, a host auth.json, or a readable runtime file', () => {
        withRun(hostAuth(), run => {
            run.writeRuntime({ ...hostAuth(), anthropic: oauth('2') });
            const before = fs.readFileSync(run.host);
            run.sync();
            assert.deepEqual(fs.readFileSync(run.host), before, 'no snapshot');

            run.seed();
            fs.writeFileSync(run.runtime, '{not json');
            run.sync();
            assert.deepEqual(fs.readFileSync(run.host), before, 'unreadable runtime auth.json');

            run.writeRuntime({ ...hostAuth(), anthropic: oauth('2') });
            fs.rmSync(run.host);
            run.sync();
            assert.equal(fs.existsSync(run.host), false, 'a removed host auth.json is not recreated');
        });
    });

    test('a seed without an imported auth.json never writes', () => {
        withRun(null, run => {
            run.seed();
            assert.equal(JSON.parse(fs.readFileSync(run.snapshot, 'utf8')), null);
            fs.writeFileSync(run.host, JSON.stringify(hostAuth()));
            run.writeRuntime({ ...hostAuth(), anthropic: oauth('2') });
            run.sync();
            assert.deepEqual(run.readHost(), hostAuth());
        });
    });

    test('accepts a host auth.json with a UTF-8 byte order mark', () => {
        withRun(hostAuth(), run => {
            fs.writeFileSync(run.host, `﻿${JSON.stringify(hostAuth())}`);
            fs.copyFileSync(run.host, run.runtime);
            run.seed();
            run.writeRuntime({ ...hostAuth(), anthropic: oauth('2') });
            run.sync();
            assert.deepEqual(run.readHost().anthropic, oauth('2'));
        });
    });

    test('takes over a stale Pi auth.json lock and releases its own', () => {
        withRun(hostAuth(), run => {
            run.seed();
            const lock = `${fs.realpathSync(run.host)}.lock`;
            fs.mkdirSync(lock);
            const stale = new Date(Date.now() - 60_000);
            fs.utimesSync(lock, stale, stale);
            run.writeRuntime({ ...hostAuth(), anthropic: oauth('2') });
            run.sync();
            assert.deepEqual(run.readHost().anthropic, oauth('2'));
            assert.equal(fs.existsSync(lock), false);
        });
    });

    test('waits for a held Pi auth.json lock, then compares against what the holder wrote', () => {
        withRun(hostAuth(), run => {
            run.seed();
            run.writeRuntime({ ...hostAuth(), anthropic: oauth('2') });
            const lock = `${fs.realpathSync(run.host)}.lock`;
            fs.mkdirSync(lock);
            // A host Pi holds the lock, refreshes the same entry, and releases it
            // while the sync it started runs. Both are plain argv processes, so no
            // shell sees the paths.
            const holder = `
import json, os, subprocess, sys, time
credentials, host, lock, runtime, snapshot = sys.argv[1:6]
sync = subprocess.Popen([sys.executable, "-I", "-B", credentials, "sync", host, runtime, snapshot])
time.sleep(0.5)
auth = json.load(open(host))
auth["anthropic"] = {"type": "oauth", "access": "access-host", "refresh": "refresh-host", "expires": 5}
open(host, "w").write(json.dumps(auth))
os.rmdir(lock)
sys.exit(sync.wait())
`;
            const script = path.join(run.dir, 'holder.py');
            fs.writeFileSync(script, holder);
            const result = spawnSync('python3', ['-I', '-B', script, credentialsScript, run.host, lock, run.runtime, run.snapshot],
                { encoding: 'utf8' });
            assert.equal(result.status, 0, result.stderr);
            assert.equal(run.readHost().anthropic.refresh, 'refresh-host');
            assert.equal(fs.existsSync(lock), false);
        });
    });

    test('creates the temp file owner-only before applying the original mode', () => {
        // Runs sync under a permissive umask and records the temp file's mode
        // whenever the helper changes its mode or renames it into place.
        const observer = `
import json, os, runpy, stat, sys
os.umask(0)
script, log = sys.argv[1], sys.argv[2]
modes = []
real_open, real_fchmod, real_replace = os.open, os.fchmod, os.replace
def record(path):
    if "propr-tmp" in os.fspath(path):
        modes.append(stat.S_IMODE(os.lstat(path).st_mode))
def tracked_open(path, flags, mode=0o777, *args, **kwargs):
    fd = real_open(path, flags, mode, *args, **kwargs)
    if "propr-tmp" in os.fspath(path):
        assert flags & os.O_EXCL and flags & os.O_CREAT, "temp file must be created exclusively"
        record(path)
    return fd
def fchmod(fd, *args, **kwargs):
    modes.append(stat.S_IMODE(os.fstat(fd).st_mode))
    return real_fchmod(fd, *args, **kwargs)
def replace(source, *args, **kwargs):
    record(source)
    return real_replace(source, *args, **kwargs)
os.open, os.fchmod, os.replace = tracked_open, fchmod, replace
sys.argv = [script, *sys.argv[3:]]
try:
    runpy.run_path(script, run_name="__main__")
except SystemExit as exit:
    if exit.code:
        raise
open(log, "w").write(json.dumps(modes))
`;
        withRun(hostAuth(), run => {
            run.seed();
            run.writeRuntime({ ...hostAuth(), anthropic: oauth('2') });
            const log = path.join(run.dir, 'modes.json');
            runPython(['-c', observer, credentialsScript, log, 'sync', run.host, run.runtime, run.snapshot]);
            const modes = JSON.parse(fs.readFileSync(log, 'utf8')) as number[];
            assert.ok(modes.length >= 2, `observed ${JSON.stringify(modes)}`);
            assert.equal(modes[0], 0o600, 'created owner-only');
            assert.ok(modes.every(mode => (mode & 0o077) === 0), `temp file was never group/world accessible: ${modes.map(m => m.toString(8))}`);
            assert.equal(fs.statSync(run.host).mode & 0o777, 0o600);
        }, 0o600);
    });

    test('refuses an unknown command', () => {
        const result = spawnSync('python3', ['-I', '-B', credentialsScript, 'push'], { encoding: 'utf8' });
        assert.equal(result.status, 64);
        assert.match(result.stderr, /Usage:/);
    });
});

describe('pi-entrypoint.sh', () => {
    const entrypoint = path.join(process.cwd(), 'scripts/pi-entrypoint.sh');

    // A stand-in pi: --version answers like Pi 1.6.1; a task run records what
    // it sees and refreshes the anthropic OAuth entry, as a token refresh would.
    const fakePi = `#!/bin/bash
if [ "$1" = "--version" ]; then echo 1.6.1; exit 0; fi
{
  echo "args=$*"
  echo "agent_dir=$PI_CODING_AGENT_DIR"
  echo "session_dir=$PI_CODING_AGENT_SESSION_DIR"
  echo "skip_version_check=$PI_SKIP_VERSION_CHECK"
  echo "telemetry=$PI_TELEMETRY"
  echo "offline=$PI_OFFLINE"
  echo "openrouter=$OPENROUTER_API_KEY"
  echo "files=$(cd "$PI_CODING_AGENT_DIR" && ls -A | LC_ALL=C sort | tr '\\n' ' ')"
  echo "auth_mode=$(stat -c %a "$PI_CODING_AGENT_DIR/auth.json")"
  echo "stdin=$(cat)"
} > "$PROPR_TEST_REPORT"
# A goal run: Pi writes its session file with its own (group/world-readable) modes.
if [ -n "\${PROPR_PI_GOAL_SESSION_DIR:-}" ]; then
  echo "goal_dir_mode=$(stat -c %a "$PROPR_PI_GOAL_SESSION_DIR")" >> "$PROPR_TEST_REPORT"
  (umask 022 && echo '{}' > "$PROPR_PI_GOAL_SESSION_DIR/2026-11-27T00-00-00-000Z_goal-session.jsonl")
fi
python3 -c '
import json, os, sys
path = os.path.join(os.environ["PI_CODING_AGENT_DIR"], "auth.json")
auth = json.load(open(path))
auth["anthropic"] = {**auth["anthropic"], "access": "access-2", "refresh": "refresh-2", "expires": 2}
json.dump(auth, open(path, "w"))
'
if [ -n "\${PROPR_TEST_RETARGET_AUTH:-}" ]; then
  ln -sfn "$PROPR_TEST_RETARGET_AUTH" "$PROPR_PI_SOURCE_DIR/auth.json"
fi
# Keep working after the refresh until the container is stopped.
if [ -n "\${PROPR_TEST_HANG:-}" ]; then echo $$ > "$PROPR_TEST_HANG"; exec sleep 60; fi
exit "\${PROPR_TEST_EXIT:-0}"
`;

    type EntrypointDirs = { source: string; runtime: string; report: string };

    function withEntrypoint(body: (env: NodeJS.ProcessEnv, dirs: EntrypointDirs) => void): void {
        const { env, dirs, cleanup } = setUpEntrypoint();
        try {
            body(env, dirs);
        } finally {
            cleanup();
        }
    }

    async function withEntrypointAsync(body: (env: NodeJS.ProcessEnv, dirs: EntrypointDirs) => Promise<void>): Promise<void> {
        const { env, dirs, cleanup } = setUpEntrypoint();
        try {
            await body(env, dirs);
        } finally {
            cleanup();
        }
    }

    function setUpEntrypoint(): { env: NodeJS.ProcessEnv; dirs: EntrypointDirs; cleanup(): void } {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-entrypoint-'));
        const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
        try {
            const source = path.join(dir, 'host', '.pi', 'agent');
            const runtime = path.join(dir, 'runtime');
            const bin = path.join(dir, 'bin');
            const home = path.join(dir, 'home');
            for (const sub of ['sessions', 'extensions']) fs.mkdirSync(path.join(source, sub), { recursive: true });
            fs.mkdirSync(bin);
            fs.mkdirSync(home);
            fs.writeFileSync(path.join(source, 'auth.json'), JSON.stringify(hostAuth(), null, 2), { mode: 0o600 });
            for (const file of ['settings.json', 'models.json', 'mcp.json', 'models-store.json']) fs.writeFileSync(path.join(source, file), '{}');
            for (const file of ['AGENTS.md', 'SYSTEM.md', 'APPEND_SYSTEM.md']) fs.writeFileSync(path.join(source, file), `# ${file}\n`);
            fs.writeFileSync(path.join(source, 'sessions', 'host-session.jsonl'), '{}\n');
            fs.writeFileSync(path.join(bin, 'pi'), fakePi, { mode: 0o755 });
            const report = path.join(dir, 'report.txt');
            const env: NodeJS.ProcessEnv = {
                ...process.env,
                HOME: home,
                PATH: `${bin}:${process.env.PATH}`,
                PROPR_PI_SOURCE_DIR: source,
                PROPR_PI_RUNTIME_HOME: runtime,
                PROPR_PI_CREDENTIALS_HELPER: credentialsScript,
                PROPR_TEST_REPORT: report,
                OPENROUTER_API_KEY: 'sk-or-forwarded',
                PI_CODING_AGENT_DIR: '/somewhere/else',
                PYTHONDONTWRITEBYTECODE: '1',
            };
            return { env, dirs: { source, runtime, report }, cleanup };
        } catch (error) {
            cleanup();
            throw error;
        }
    }

    const reportOf = (file: string) => Object.fromEntries(fs.readFileSync(file, 'utf8').trim().split('\n').map(line => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1)];
    }));

    test('runs Pi in a disposable agent dir seeded from the host and writes OAuth refreshes back', () => {
        withEntrypoint((env, dirs) => {
            const result = spawnSync('bash', [entrypoint, '-p', '--mode', 'json'], { env, encoding: 'utf8', input: 'prompt' });
            assert.equal(result.status, 0, result.stderr);
            const report = reportOf(dirs.report);
            const agentDir = path.join(dirs.runtime, 'agent');
            assert.equal(report.args, '-p --mode json', 'flags-only commands run pi');
            assert.equal(report.agent_dir, agentDir);
            assert.equal(report.session_dir, path.join(agentDir, 'sessions'));
            assert.equal(report.skip_version_check, '1');
            assert.equal(report.telemetry, '0');
            assert.equal(report.offline, '1');
            assert.equal(report.openrouter, 'sk-or-forwarded', 'agent env vars reach Pi');
            assert.equal(report.files.trim(), 'AGENTS.md APPEND_SYSTEM.md SYSTEM.md auth.json models.json sessions settings.json');
            assert.equal(report.auth_mode, '600');
            assert.equal(report.stdin, 'prompt', 'the prompt on stdin reaches the supervised task');
            assert.deepEqual(fs.readdirSync(path.join(agentDir, 'sessions')), [], 'host sessions are not imported');
            assert.match(result.stderr, /Pi CLI version: 1\.6\.1/);
            assert.doesNotMatch(result.stdout, /\S/, 'diagnostics stay off stdout');

            const host = JSON.parse(fs.readFileSync(path.join(dirs.source, 'auth.json'), 'utf8')) as Auth;
            assert.deepEqual(host, { ...hostAuth(), anthropic: { ...hostAuth().anthropic, access: 'access-2', refresh: 'refresh-2', expires: 2 } });
            assert.equal(fs.statSync(path.join(dirs.source, 'auth.json')).mode & 0o777, 0o600);
        });
    });

    test('propagates the task exit status and still syncs credentials', () => {
        withEntrypoint((env, dirs) => {
            const result = spawnSync('bash', [entrypoint, 'pi', '-p'], { env: { ...env, PROPR_TEST_EXIT: '7' }, encoding: 'utf8' });
            assert.equal(result.status, 7, result.stderr);
            const host = JSON.parse(fs.readFileSync(path.join(dirs.source, 'auth.json'), 'utf8')) as Auth;
            assert.equal(host.anthropic.refresh, 'refresh-2');
        });
    });

    test('does not write a refresh to either target if the host auth link changed during the run', () => {
        withEntrypoint((env, dirs) => {
            const link = path.join(dirs.source, 'auth.json');
            const original = path.join(dirs.source, 'original.json');
            const replacement = path.join(dirs.source, 'replacement.json');
            fs.renameSync(link, original);
            fs.copyFileSync(original, replacement);
            fs.symlinkSync(original, link);

            const result = spawnSync('bash', [entrypoint, 'pi', '-p'], {
                env: { ...env, PROPR_TEST_RETARGET_AUTH: replacement }, encoding: 'utf8',
            });
            assert.equal(result.status, 0, result.stderr);
            // A symlinked auth.json is never written back, and the warning says what that costs.
            assert.match(result.stderr, /auth\.json is a symlink; refreshed credentials will not be written back, so the host login goes stale/);
            assert.equal(fs.readlinkSync(link), replacement);
            for (const target of [original, replacement]) {
                assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), hostAuth());
            }
        });
    });

    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        test(`forwards ${signal} to the running task, waits for it and still syncs refreshed credentials`, async () => {
            await withEntrypointAsync(async (env, dirs) => {
                const ready = path.join(dirs.runtime, '..', 'pi.pid');
                const child = spawn('bash', [entrypoint, 'pi', '-p'], { env: { ...env, PROPR_TEST_HANG: ready }, stdio: ['pipe', 'ignore', 'pipe'] });
                child.stdin.end();
                let stderr = '';
                child.stderr.on('data', chunk => { stderr += String(chunk); });
                const exited = new Promise<number | null>(resolve => { child.on('exit', code => resolve(code)); });
                const deadline = Date.now() + 20_000;
                while (!(fs.existsSync(ready) && fs.readFileSync(ready, 'utf8').trim())) {
                    assert.ok(Date.now() < deadline, `task never started: ${stderr}`);
                    await new Promise(resolve => setTimeout(resolve, 20));
                }
                // The task has refreshed its token and is still working. docker
                // stop: tini signals only the entrypoint shell.
                child.kill(signal);
                const code = await Promise.race([exited, new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 20_000))]);
                if (code === 'timeout') child.kill('SIGKILL');
                assert.equal(code, signal === 'SIGTERM' ? 143 : 130, stderr);
                const taskPid = Number(fs.readFileSync(ready, 'utf8').trim());
                assert.throws(() => process.kill(taskPid, 0), `the task was stopped, not orphaned: ${stderr}`);
                const host = JSON.parse(fs.readFileSync(path.join(dirs.source, 'auth.json'), 'utf8')) as Auth;
                assert.deepEqual(host, { ...hostAuth(), anthropic: { ...hostAuth().anthropic, access: 'access-2', refresh: 'refresh-2', expires: 2 } });
            });
        });
    }

    test('writes the ProPR-generated mcp.json and never the host one', () => {
        withEntrypoint((env, dirs) => {
            const mcp = JSON.stringify({ mcpServers: { scout: { command: 'propr-scout' } } });
            const result = spawnSync('bash', [entrypoint, 'pi', '-p'], { env: { ...env, PROPR_PI_MCP_CONFIG: mcp }, encoding: 'utf8' });
            assert.equal(result.status, 0, result.stderr);
            const written = path.join(dirs.runtime, 'agent', 'mcp.json');
            assert.equal(fs.readFileSync(written, 'utf8').trim(), mcp);
            assert.equal(fs.statSync(written).mode & 0o777, 0o600);
        });
    });

    test('starts from a fresh agent dir every run', () => {
        withEntrypoint((env, dirs) => {
            fs.mkdirSync(path.join(dirs.runtime, 'agent', 'extensions'), { recursive: true });
            fs.writeFileSync(path.join(dirs.runtime, 'agent', 'mcp.json'), '{"stale":true}');
            const result = spawnSync('bash', [entrypoint, 'pi', '-p'], { env, encoding: 'utf8' });
            assert.equal(result.status, 0, result.stderr);
            assert.equal(fs.existsSync(path.join(dirs.runtime, 'agent', 'extensions')), false);
            assert.equal(fs.existsSync(path.join(dirs.runtime, 'agent', 'mcp.json')), false);
        });
    });

    test('refuses a runtime home inside the host Pi dir', () => {
        withEntrypoint((env, dirs) => {
            const result = spawnSync('bash', [entrypoint, 'pi', '--version'], { env: { ...env, PROPR_PI_RUNTIME_HOME: path.join(dirs.source, 'runtime') }, encoding: 'utf8' });
            assert.equal(result.status, 64);
            assert.equal(fs.existsSync(path.join(dirs.source, 'runtime')), false);
        });
    });

    test('refuses a runtime home that contains the host Pi dir before deleting anything', () => {
        withEntrypoint((env, dirs) => {
            const piDir = path.dirname(dirs.source);
            const link = path.join(dirs.runtime, '..', 'pi-link');
            fs.symlinkSync(piDir, link);
            // The parent of the source dir (the PROPR_PI_RUNTIME_HOME=/home/node/.pi case),
            // the same dir spelled through `..`, and a symlink to it.
            for (const runtimeHome of [piDir, path.join(dirs.source, '..'), link]) {
                const result = spawnSync('bash', [entrypoint, 'pi', '--version'], { env: { ...env, PROPR_PI_RUNTIME_HOME: runtimeHome }, encoding: 'utf8' });
                assert.equal(result.status, 64, `${runtimeHome}: ${result.stderr}`);
                assert.match(result.stderr, /must not contain the host Pi dir/);
                assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dirs.source, 'auth.json'), 'utf8')), hostAuth());
                assert.deepEqual(fs.readdirSync(path.join(dirs.source, 'sessions')), ['host-session.jsonl']);
            }
        });
    });

    test('keeps a goal\'s mounted session dir across runs and makes it owner-only before and after Pi runs', () => {
        withEntrypoint((env, dirs) => {
            const goalSessions = path.join(dirs.runtime, '..', 'goal-sessions');
            fs.mkdirSync(goalSessions, { mode: 0o755 });
            fs.chmodSync(goalSessions, 0o755);
            const earlier = path.join(goalSessions, '2026-11-26T00-00-00-000Z_goal-session-old.jsonl');
            fs.writeFileSync(earlier, '{}\n', { mode: 0o644 });
            fs.chmodSync(earlier, 0o644);
            const result = spawnSync('bash', [entrypoint, 'pi', '-p'], { env: { ...env, PROPR_PI_GOAL_SESSION_DIR: goalSessions }, encoding: 'utf8' });
            assert.equal(result.status, 0, result.stderr);
            assert.equal(reportOf(dirs.report).goal_dir_mode, '700', 'restricted before Pi starts');
            assert.equal(fs.statSync(goalSessions).mode & 0o777, 0o700);
            assert.deepEqual(fs.readdirSync(goalSessions).sort(), ['2026-11-26T00-00-00-000Z_goal-session-old.jsonl', '2026-11-27T00-00-00-000Z_goal-session.jsonl']);
            for (const file of fs.readdirSync(goalSessions)) assert.equal(fs.statSync(path.join(goalSessions, file)).mode & 0o777, 0o600, file);
        });
    });

    test('refuses a goal session dir inside the disposable home or missing from the container', () => {
        withEntrypoint((env, dirs) => {
            const inside = spawnSync('bash', [entrypoint, 'pi', '-p'], { env: { ...env, PROPR_PI_GOAL_SESSION_DIR: path.join(dirs.runtime, 'agent', 'sessions') }, encoding: 'utf8' });
            assert.equal(inside.status, 64, inside.stderr);
            assert.match(inside.stderr, /outside the disposable Pi home/);
            const missing = spawnSync('bash', [entrypoint, 'pi', '-p'], { env: { ...env, PROPR_PI_GOAL_SESSION_DIR: path.join(dirs.runtime, '..', 'not-mounted') }, encoding: 'utf8' });
            assert.equal(missing.status, 64, missing.stderr);
            assert.match(missing.stderr, /not mounted/);
        });
    });

    test('refuses a runtime home equal to the host Pi dir', () => {
        withEntrypoint((env, dirs) => {
            const result = spawnSync('bash', [entrypoint, 'pi', '--version'], { env: { ...env, PROPR_PI_RUNTIME_HOME: `${dirs.source}/` }, encoding: 'utf8' });
            assert.equal(result.status, 64);
            assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dirs.source, 'auth.json'), 'utf8')), hostAuth());
        });
    });

    test('runs without a mounted host dir', () => {
        withEntrypoint((env, dirs) => {
            const result = spawnSync('bash', [entrypoint, 'pi', '--version'], { env: { ...env, PROPR_PI_SOURCE_DIR: path.join(dirs.runtime, '..', 'missing') }, encoding: 'utf8' });
            assert.equal(result.status, 0, result.stderr);
            assert.equal(result.stdout.trim(), '1.6.1');
            assert.match(result.stderr, /not mounted/);
        });
    });

    test('login mode runs Pi on the mounted credential dir without a disposable copy or write-back', () => {
        withEntrypoint((env, dirs) => {
            const result = spawnSync('bash', [entrypoint, 'pi', 'auth', 'login', 'anthropic', '--no-browser'], {
                env: { ...env, PROPR_PI_LOGIN: '1' }, encoding: 'utf8', input: '',
            });
            assert.equal(result.status, 0, result.stderr);
            const report = reportOf(dirs.report);
            assert.equal(report.args, 'auth login anthropic --no-browser');
            assert.equal(report.agent_dir, dirs.source, 'Pi writes the login into the mounted dir');
            assert.equal(report.session_dir, '', 'no disposable session dir in login mode');
            assert.equal(fs.existsSync(dirs.runtime), false, 'no disposable home is created');
            assert.match(result.stderr, /Executing command: pi auth login/);
            // The fake Pi's own write lands directly in the host file.
            const host = JSON.parse(fs.readFileSync(path.join(dirs.source, 'auth.json'), 'utf8')) as Auth;
            assert.equal(host.anthropic.access, 'access-2');
        });
    });

    test('login mode refuses a missing credential dir', () => {
        withEntrypoint((env, dirs) => {
            const result = spawnSync('bash', [entrypoint, 'pi', 'auth', 'login', 'anthropic'], {
                env: { ...env, PROPR_PI_LOGIN: '1', PROPR_PI_SOURCE_DIR: path.join(dirs.runtime, '..', 'missing') }, encoding: 'utf8',
            });
            assert.equal(result.status, 64);
            assert.match(result.stderr, /not mounted/);
        });
    });

    test('drops to node through su-exec for every Pi call when started as root', () => {
        const script = fs.readFileSync(entrypoint, 'utf8');
        assert.match(script, /\n        \/usr\/local\/bin\/su-exec node \/usr\/bin\/env HOME=\/home\/node USER=node LOGNAME=node PATH="\$pi_node_path" "\$@"/);
        assert.match(script, /\n        exec \/usr\/local\/bin\/su-exec node \/usr\/bin\/env HOME=\/home\/node USER=node LOGNAME=node PATH="\$pi_node_path" "\$@"/);
        assert.match(script, /\n        \/usr\/local\/bin\/su-exec node \/usr\/bin\/env -i HOME=\/nonexistent PATH="\$POST_TASK_PATH" "\$@"/);
        for (const call of ['run_as_node /usr/bin/python3 -I -B "$pi_credentials_helper" seed', 'run_post_task_as_node /usr/bin/python3 -I -B "$pi_credentials_helper" seed', 'run_as_node pi --version', 'exec_as_node env --default-signal=INT,QUIT "$@"']) {
            assert.ok(script.includes(call), `${call} must run as node`);
        }
        // Outside run_as_node itself, nothing invokes pi or the helper directly.
        const direct = script.split('\n').filter(line => /(^|[\s;(])(pi|python3)\s/.test(line.trim()) && !/run_(post_task_)?as_node|exec_as_node/.test(line) && !line.includes('set -- pi') && !line.trim().startsWith('#'));
        assert.deepEqual(direct, []);
    });

    test('post-task privileged steps use the fixed PATH and only absolute binaries', () => {
        const script = fs.readFileSync(entrypoint, 'utf8');
        assert.match(script, /^POST_TASK_PATH=\/usr\/sbin:\/usr\/bin:\/sbin:\/bin$/m);
        assert.match(script, /pi_node_path="\/home\/node\/bin:\$pi_node_path"/);
        assert.doesNotMatch(script, /export PATH="\/home\/node\/bin:/);
        const postTask = script.slice(script.indexOf('# ---- Post-task privileged steps'));
        const lines = postTask.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
        assert.equal(lines[0], 'export PATH="$POST_TASK_PATH"', 'the fixed PATH is set first thing after the task');
        assert.ok(lines.includes('cd /'), 'post-task steps leave the task-writable workspace');
        assert.match(postTask, /\| \/usr\/bin\/env -i PATH="\$POST_TASK_PATH" \/usr\/bin\/python3 -I -B "\$pi_credentials_helper" sync-from-stdin/);
        assert.match(script, /restrict_goal_sessions_after_task\(\) \{\n[^}]*run_post_task_as_node \/bin\/chmod -R -- u\+rwX,go-rwx "\$pi_goal_session_dir"/);
        assert.doesNotMatch(script.slice(script.indexOf('restrict_goal_sessions_after_task()'), script.indexOf('prepare_goal_sessions()')), /chown/, 'no recursive chown over the tree the task just wrote');
        // Only the store directory returns to the worker's UID, non-recursively
        // and through the descriptor pinned before the task.
        assert.match(script, /exec 8<"\$pi_goal_session_dir\/" \|\| return\n\s+pi_goal_session_owner="\$\(\/usr\/bin\/stat -L -c %u:%g -- \/proc\/self\/fd\/8\)"/);
        assert.match(script, /restore_goal_session_owner\(\) \{\n[^}]*\/usr\/bin\/env -i \/bin\/chown -- "\$pi_goal_session_owner" \/proc\/self\/fd\/8\n\}/);
        assert.ok(lines.indexOf('exec 8<&-') > lines.findIndex(line => line.startsWith('restore_goal_session_owner')), 'the pinned store is closed after it is handed back');
        // No node process ever inherits the pinned store descriptor.
        for (const fn of ['run_as_node', 'exec_as_node', 'run_post_task_as_node']) {
            const body = script.slice(script.indexOf(`${fn}() {`), script.indexOf('\n}\n', script.indexOf(`${fn}() {`)));
            assert.equal((body.match(/"\$@" 8<&-/g) ?? []).length, 2, `${fn} closes fd 8 in both branches`);
        }
        // Every external command after the task is called by absolute path.
        const external = /(^|[\s;|&({])(cp|chown|chmod|python3|mkdir|rm|ln|mv|realpath|env|su-exec|stat|find|cat|install|git|sh|bash)(\s|$)/;
        assert.deepEqual(lines.filter(line => external.test(line)), [], 'bare external commands after the task');
        // As root, the helper always comes from the image.
        assert.match(script, /if \[ "\$EUID" = "0" \]; then\n    pi_credentials_helper=\/opt\/propr\/pi-credentials\.py/);
    });

    test('a task that replaces node’s bin dir with fake cp/chown/chmod/python3 gets none of them run after it exits', () => {
        withEntrypoint((env, dirs) => {
            // Stands in for /home/node/bin: first on both the task PATH and,
            // as in production before hardening, the entrypoint's own PATH.
            const nodeBin = path.join(dirs.runtime, '..', 'node-bin');
            const marker = path.join(dirs.runtime, '..', 'fake-binary-ran');
            fs.mkdirSync(nodeBin);
            const goalSessions = path.join(dirs.runtime, '..', 'goal-sessions');
            fs.mkdirSync(goalSessions, { mode: 0o700 });
            const poison = `
/bin/rm -rf "$PROPR_TEST_NODE_BIN" && /bin/mkdir "$PROPR_TEST_NODE_BIN"
for tool in cp chown chmod python3 python3.11 env mkdir rm ln mv realpath stat su-exec cat find; do
  printf '#!/bin/sh\necho "$0 $*" >> "%s"\nexit 0\n' "$PROPR_TEST_MARKER" > "$PROPR_TEST_NODE_BIN/$tool"
  /bin/chmod +x "$PROPR_TEST_NODE_BIN/$tool"
done
`;
            const fakePiPath = path.join(path.dirname(dirs.runtime), 'bin', 'pi');
            const piScript = fs.readFileSync(fakePiPath, 'utf8').replace('exit "${PROPR_TEST_EXIT:-0}"', `${poison}\nexit 0`);
            fs.writeFileSync(fakePiPath, piScript);
            const taskPath = `${nodeBin}:${env.PATH}`;
            const result = spawnSync('bash', [entrypoint, 'pi', '-p'], {
                env: { ...env, PATH: taskPath, PROPR_PI_NODE_PATH: taskPath, PROPR_TEST_NODE_BIN: nodeBin, PROPR_TEST_MARKER: marker, PROPR_PI_GOAL_SESSION_DIR: goalSessions },
                encoding: 'utf8',
            });
            assert.equal(result.status, 0, result.stderr);
            assert.ok(fs.existsSync(path.join(nodeBin, 'python3')), 'the task did plant the fakes');
            assert.equal(fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '', '', 'no fake binary ran after the task');
            const host = JSON.parse(fs.readFileSync(path.join(dirs.source, 'auth.json'), 'utf8')) as Auth;
            assert.equal(host.anthropic.refresh, 'refresh-2', 'the real helper wrote the refresh back');
            assert.equal(fs.statSync(path.join(dirs.source, 'auth.json')).mode & 0o777, 0o600);
            for (const file of fs.readdirSync(goalSessions)) assert.equal(fs.statSync(path.join(goalSessions, file)).mode & 0o777, 0o600, `${file} restricted by the real chmod`);
        });
    });
});
