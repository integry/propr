import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ORG_TOKEN } from './helpers/spritesHarness.ts';

const { buildSpritesPayload } = await import('../packages/core/src/agents/runtime/sprites/spritesRunPlan.ts');
const { readSpriteCredentialExport } = await import('../packages/core/src/agents/runtime/sprites/spritesExport.ts');

/**
 * Runs the real `scripts/sprites-launcher.sh` against a payload the runtime
 * built. The test is not root, so the commands that need root are replaced by
 * shell functions (the privilege drop runs the command as is, `chown` is a
 * no-op, `install` drops its owner flags); everything else, from unpacking the
 * archive to the exit status, is the script's own code.
 */
const launcher = path.resolve(import.meta.dirname, '..', 'scripts', 'sprites-launcher.sh');
const UNUSED_UID = '4123456789';

function harness(root: string, command: string): string {
    return `
source "${launcher}"
RUN_DIR="${root}/run"
TMP_DIR="${root}/sprite/tmp"
MOUNT_DIR="${root}/sprite/mounts"
id() { if [ "$#" = 1 ] && [ "$1" = "-u" ]; then echo 0; else command id "$@"; fi; }
agent_uid() { echo ${UNUSED_UID}; }
su-exec() { shift; "$@"; }
chown() { :; }
install() { local args=(); while [ "$#" -gt 0 ]; do case "$1" in -o|-g) shift 2 ;; *) args+=("$1"); shift ;; esac; done; command install "\${args[@]}"; }
${command}
`;
}

/** A payload as the runtime builds it, with every target below `root` (the test must not touch the real /home/node). */
function writePayload(root: string, script: string, options: { stdin?: string } = {}): { live: string; seed: string; scratch: string; logs: string } {
    const store = path.join(root, 'canonical');
    fs.mkdirSync(path.join(store, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(store, '.credentials.json'), 'token-v1', { mode: 0o600 });
    fs.utimesSync(path.join(store, '.credentials.json'), 1_600_000_000, 1_600_000_000);
    fs.writeFileSync(path.join(store, 'skills', 'SKILL.md'), 'skill');
    const seedSource = path.join(root, 'seed.json');
    fs.writeFileSync(seedSource, '{"seed":true}');
    const target = path.join(root, 'sprite', 'home', '.claude');
    const seed = path.join(root, 'sprite', 'run', 'claude.json');
    const scratch = path.join(root, 'sprite', 'scratch');
    // Stands in for /tmp, the disk a Sprite's checkpoint does not cover (the harness points TMP_DIR at it).
    fs.mkdirSync(path.join(root, 'sprite', 'tmp'), { recursive: true });
    const logs = path.join(root, 'sprite', 'tmp', 'claude-logs');
    const live = path.join(target, '.credentials.json');
    const file = (name: string, content: string, mode = 0o600, mtimeMs = 1_600_000_000_000) => ({ path: name, content: Buffer.from(content), mode, mtimeMs, uid: 0, gid: 0, refresh: name === '.credentials.json' });
    const plan = {
        argv: ['/bin/bash', '-c', script, 'propr-run', 'first arg', 'second'],
        environment: new Map([['PATH', process.env.PATH ?? ''], ['RUN_VALUE', 'a value with spaces'], ['LIVE', live], ['SEED', seed], ['SCRATCH', scratch], ['LOGS', logs], ['SOURCE', path.join(root, 'sprite', 'source')]]),
        withheld: [],
        credentialMounts: [
            { type: 'bind', source: store, target, readOnly: false, purpose: 'credential', order: 0, credentialStore: { provider: 'claude', store: 'config', perRun: true } },
            { type: 'bind', source: store, target: path.join(root, 'sprite', 'source'), readOnly: true, purpose: 'credential', order: 1, credentialStore: { provider: 'claude', store: 'config', perRun: true } },
        ],
        files: [{ source: seedSource, target: seed }],
        directories: [scratch, logs],
    };
    const stores = ['a', 'b'].map(id => ({
        id, provider: 'claude', store: 'config', canonicalRoot: store, directories: ['skills'], outputs: ['.credentials.json'], skipped: [], baseline: {},
        files: [file('.credentials.json', 'token-v1'), file('skills/SKILL.md', 'skill', 0o644)],
    }));
    const credentials = { broker: undefined, bundle: { stores, secretEnv: {} }, outputs: [{ storeId: 'a', path: '.credentials.json', livePath: live }] };
    fs.mkdirSync(path.join(root, 'run'), { recursive: true });
    fs.writeFileSync(path.join(root, 'run', 'payload.tar'), buildSpritesPayload(plan as never, { credentials: credentials as never, stdin: options.stdin !== undefined, stdinData: options.stdin }));
    return { live, seed, scratch, logs };
}

function bash(script: string) {
    return spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', [`PROPR_SPRITES_TOKEN`]: ORG_TOKEN } });
}

test('the real launcher installs the payload, runs the command with only its environment, exports the credential and records the status', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-launcher-'));
    const { live, seed, scratch, logs } = writePayload(root, `
        echo "args=$1|$2 value=$RUN_VALUE token=\${PROPR_SPRITES_TOKEN:-unset}"
        echo "stdin=$(cat)"
        echo "received=$(cat "$LIVE") mode=$(stat -c %a "$LIVE") mtime=$(stat -c %Y "$LIVE")"
        echo "skill=$(cat "$(dirname "$LIVE")/skills/SKILL.md") seed=$(cat "$SEED") seed-mode=$(stat -c %a "$SEED")"
        echo "source=$(cat "$SOURCE/.credentials.json") source-mode=$(stat -c %a "$SOURCE/.credentials.json")"
        echo "scratch=$([ -d "$SCRATCH" ] && echo present)"
        echo log-line > "$LOGS/session.jsonl"
        echo stray > "$(dirname "$LOGS")/written-by-the-agent"
        mkdir -p "$(dirname "$LOGS")/nested/deeper" && ln -s "$SEED" "$(dirname "$LOGS")/nested/deeper/link-out"
        printf token-v2 > "$LIVE"; touch -d @1700000000 "$LIVE"
        echo "to stderr" >&2
        exit 7
    `, { stdin: 'the prompt' });
    const run = bash(harness(root, 'run_launcher'));
    assert.equal(run.status, 7, run.stderr);
    const runDir = path.join(root, 'run');
    const stdout = fs.readFileSync(path.join(runDir, 'stdout.log'), 'utf8');
    // `env -i`: the command sees the payload's environment and nothing of the launcher's own (the org token is in it here).
    assert.match(stdout, /args=first arg\|second value=a value with spaces token=unset/);
    assert.match(stdout, /stdin=the prompt/);
    assert.match(stdout, /received=token-v1 mode=600 mtime=1600000000/);
    assert.match(stdout, /skill=skill seed=\{"seed":true\} seed-mode=440/);
    // The read-only source: no write bit for the agent user's group, nothing for others.
    assert.match(stdout, /source=token-v1 source-mode=640/);
    assert.match(stdout, /scratch=present/);
    assert.equal(fs.readFileSync(path.join(runDir, 'stderr.log'), 'utf8'), 'to stderr\n');
    assert.equal(fs.readFileSync(path.join(runDir, 'exit-status'), 'utf8'), '7\n');
    assert.equal(fs.readFileSync(path.join(runDir, 'export-status'), 'utf8'), 'ok\n');
    // Secrets do not stay in the run directory, and the archive is gone.
    for (const gone of ['payload.tar', 'in/env', 'in/store', 'in/files', 'in/manifest']) assert.ok(!fs.existsSync(path.join(runDir, gone)), gone);
    assert.deepEqual(fs.readdirSync(path.join(runDir, 'out')).sort(), ['0', '0.mtime']);
    assert.equal(fs.readFileSync(path.join(runDir, 'out', '0'), 'utf8'), 'token-v2');
    assert.equal(fs.readFileSync(path.join(runDir, 'out', '0.mtime'), 'utf8'), '1700000000\n');
    assert.equal(fs.readFileSync(live, 'utf8'), 'token-v2');
    assert.ok(fs.existsSync(seed) && fs.existsSync(scratch));
    assert.ok(fs.lstatSync(scratch).isDirectory(), 'a directory outside /tmp is created where it was asked for');
    // The directory the run was to get under /tmp is a link there: what the run wrote to it is on the checkpointed root.
    const tmp = path.dirname(logs);
    const mounts = path.join(root, 'sprite', 'mounts');
    assert.ok(fs.lstatSync(logs).isSymbolicLink());
    assert.equal(path.dirname(fs.readlinkSync(logs)), mounts);
    assert.equal(fs.readFileSync(path.join(fs.readlinkSync(logs), 'session.jsonl'), 'utf8'), 'log-line\n');
    // `scrub` empties /tmp without following the links in it: the linked directory and the file a planted link points to stay.
    assert.deepEqual(fs.readdirSync(tmp).sort(), ['claude-logs', 'nested', 'written-by-the-agent']);
    const scrubbed = bash(harness(root, 'scrub_run'));
    assert.equal(scrubbed.status, 0, scrubbed.stderr);
    assert.deepEqual(fs.readdirSync(tmp), []);
    assert.equal(fs.readFileSync(path.join(fs.readdirSync(mounts).map(name => path.join(mounts, name))[0], 'session.jsonl'), 'utf8'), 'log-line\n');
    assert.equal(fs.readFileSync(seed, 'utf8'), '{"seed":true}');
    // A /tmp it cannot empty is reported, so the worker destroys the Sprite instead of restoring it.
    const stuck = bash(harness(root, 'echo left > "$TMP_DIR/left"; find() { if [ "$5" = "-delete" ]; then return 1; fi; command find "$@"; }; scrub_run'));
    assert.equal(stuck.status, 1);
    assert.match(stuck.stderr, /could not empty .*\/sprite\/tmp/);
    fs.rmSync(path.join(tmp, 'left'));

    // The worker's reader takes that export as it is.
    const filesystem = {
        readFile: async (file: string) => fs.readFileSync(file),
        writeFile: async () => undefined, mkdir: async () => undefined,
        stat: async (file: string) => {
            const stat = fs.lstatSync(file);
            return { size: stat.size, isFile: () => stat.isFile(), isDirectory: () => stat.isDirectory(), isSymbolicLink: () => stat.isSymbolicLink() };
        },
    };
    assert.deepEqual(await readSpriteCredentialExport(filesystem, path.join(runDir, 'out'), 0), { content: Buffer.from('token-v2'), mtimeMs: 1_700_000_000_000 });

    const status = bash(harness(root, 'print_status'));
    assert.equal(status.stdout, 'running=0\nexit=7\nexport=ok\n');
    const followed = bash(harness(root, 'follow_output stdout 1'));
    assert.equal(followed.stdout, stdout);
    assert.equal(bash(harness(root, 'follow_output stdout 6')).stdout, stdout.slice(5), 'a 1-based byte offset resumes mid-stream');
    assert.equal(bash(harness(root, 'follow_output secrets 1')).status, 2);

    // A second run on the same, unrestored run directory is refused: the launcher never cleans up for one.
    writePayload(root, 'echo should-not-run');
    const again = bash(harness(root, 'run_launcher'));
    assert.equal(again.status, 125);
    assert.match(fs.readFileSync(path.join(runDir, 'stderr.log'), 'utf8'), /the run directory already holds a run: the Sprite is not at its clean checkpoint/);
    assert.equal(fs.readFileSync(path.join(runDir, 'export-status'), 'utf8'), 'none\n');
    assert.doesNotMatch(fs.readFileSync(path.join(runDir, 'stdout.log'), 'utf8'), /should-not-run/);
});

test('the real launcher forwards TERM to the command and still exports; a planted symlink exports nothing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-launcher-'));
    const secret = path.join(root, 'root-only-secret');
    fs.writeFileSync(secret, 'never exported');
    writePayload(root, `
        trap 'echo terminated; rm -f "$LIVE"; ln -s "${secret}" "$LIVE"; exit 143' TERM
        echo started
        while :; do sleep 0.1; done
    `);
    const child = spawn('bash', ['-c', harness(root, 'run_launcher')], { stdio: 'ignore' });
    const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)));
    const stdoutLog = path.join(root, 'run', 'stdout.log');
    for (let attempt = 0; attempt < 200 && !(fs.existsSync(stdoutLog) && fs.readFileSync(stdoutLog, 'utf8').includes('started')); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(bash(harness(root, 'print_status')).stdout, 'running=1\nexit=\nexport=\n');
    assert.equal(bash(harness(root, 'signal_run TERM')).status, 0);
    assert.equal(await exited, 143);
    assert.match(fs.readFileSync(stdoutLog, 'utf8'), /terminated/);
    assert.equal(fs.readFileSync(path.join(root, 'run', 'exit-status'), 'utf8'), '143\n');
    assert.equal(fs.readFileSync(path.join(root, 'run', 'export-status'), 'utf8'), 'ok\n');
    assert.deepEqual(fs.readdirSync(path.join(root, 'run', 'out')), [], 'the symlink the run left at its credential path is not exported');
    assert.equal(fs.readFileSync(secret, 'utf8'), 'never exported');
    // KILL with nothing left to kill reports a stopped run.
    assert.equal(bash(harness(root, 'signal_run KILL')).status, 0);
});
