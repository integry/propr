import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const credentialRunDir = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-fly-mount-credential-runs-'));
process.env.PROPR_AGENT_CREDENTIAL_RUN_DIR = credentialRunDir;

// The runtime modules import @propr/core, which opens the shared database connection; close it or the test never exits.
after(async () => {
    const { closeConnection } = await import('../packages/core/src/db/connection.ts');
    await closeConnection();
    fs.rmSync(credentialRunDir, { recursive: true, force: true });
});

const { renderFlyMachineRequest, flyMachineMounts, FLY_RUN_FILES } = await import('../packages/core/src/agents/runtime/flyMachinesLaunch.ts');
const { uploadAgentRunFiles } = await import('../packages/core/src/agents/runtime/agentRunFileUpload.ts');
const { AgentRunSpecBuilder, agentRunNetwork } = await import('../packages/core/src/agents/runtime/agentRunSpec.ts');

const CONFIG = { size: 'performance-1x', resultLingerSeconds: 0 } as const;

function tempDir(prefix: string): string {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function builder(name: string) {
    return new AgentRunSpecBuilder({
        agentType: 'claude', image: 'propr/agent:test', name, stdin: false, user: '0:0', network: agentRunNetwork('bridge'),
        workspace: { hostPath: '/tmp/w', containerPath: '/home/node/workspace', readOnly: false, mode: 'clone' },
    });
}

function prepared(run: any) {
    run.entrypoint = '/home/node/claude-entrypoint.sh';
    run.workspace.clone = { remote: 'https://github.com/o/r.git', baseRef: 'refs/propr/runs/x/base', baseCommit: 'abc', branch: 'b', resultRef: 'refs/propr/runs/x/result', resultDir: '/tmp/r', script: 'clone-script' };
    return run;
}

/** A Claude-shaped run: writable credential store, read-only config seed file, read-only data directory, backups tmpfs. */
function claudeRun(guest: string) {
    const store = tempDir('propr-fly-mount-store-');
    fs.writeFileSync(path.join(store, '.credentials.json'), '{"token":"old"}', { mode: 0o600 });
    const seed = path.join(tempDir('propr-fly-mount-seed-'), 'claude.json');
    fs.writeFileSync(seed, '{"seed":true}', { mode: 0o600 });
    const data = tempDir('propr-fly-mount-data-');
    fs.mkdirSync(path.join(data, 'nested'));
    fs.writeFileSync(path.join(data, 'nested', 'fixture.txt'), 'fixture');
    const run = builder('mounts-claude')
        .credentialBind(store, `${guest}/claude`, false, { provider: 'claude', store: 'config', perRun: true })
        .strictBind(seed, `${guest}/seed/claude.json`, true, 'credential')
        .bind(data, `${guest}/data`, true, 'data')
        .tmpfs(`${guest}/claude/backups`, 'rw,nosuid,nodev,noexec,size=16m')
        .command('claude').build();
    return prepared(run);
}

function machineFile(request: any, guestPath: string): string | undefined {
    const file = request.config.files.find((candidate: any) => candidate.guest_path === guestPath);
    return file ? Buffer.from(file.raw_value, 'base64').toString('utf8') : undefined;
}

test('upload conversion keeps the read-only restriction on every entry of a read-only bind, credential stores included', () => {
    const guest = '/opt/propr-guest';
    const uploaded = uploadAgentRunFiles(claudeRun(guest));
    const entries = new Map(uploaded.spec.files!.map(file => [file.path, file]));
    assert.equal(entries.get(`${guest}/seed/claude.json`)!.readOnly, true);
    assert.equal(entries.get(`${guest}/data`)!.readOnly, true);
    assert.equal(entries.get(`${guest}/data/nested/fixture.txt`)!.readOnly, true);
    assert.equal(entries.get(`${guest}/claude/.credentials.json`)!.readOnly, undefined, 'the writable store stays writable');
    assert.ok(uploaded.spec.mounts.some(mount => mount.type === 'tmpfs'), 'the tmpfs survives conversion');

    const store = tempDir('propr-fly-mount-ro-store-');
    fs.writeFileSync(path.join(store, '.credentials.json'), '{"token":"old"}', { mode: 0o600 });
    const readOnlyStore = prepared(builder('mounts-ro-store')
        .credentialBind(store, `${guest}/claude`, true, { provider: 'claude', store: 'config', perRun: true }).command('claude').build());
    const storeFiles = uploadAgentRunFiles(readOnlyStore).spec.files!.filter(file => file.path.startsWith(`${guest}/claude`));
    assert.ok(storeFiles.length > 1 && storeFiles.every(file => file.readOnly), 'a read-only credential store is read-only in the run');
});

test('rendering: read-only uploads become read-only self-binds and each tmpfs keeps its options, on Docker defaults', () => {
    const guest = '/opt/propr-guest';
    const request = renderFlyMachineRequest(uploadAgentRunFiles(claudeRun(guest)).spec, { config: CONFIG, launchEnvironment: {} });
    assert.equal(machineFile(request, FLY_RUN_FILES.mounts), [
        `r\t-\t${guest}/seed/claude.json`,
        `r\t-\t${guest}/data`,
        `t\tnoexec,nosuid,nodev,rw,nosuid,nodev,noexec,size=16m\t${guest}/claude/backups`,
    ].map(line => `${line}\n`).join(''), 'one bind per outermost read-only upload, then the tmpfs');
    const plain = prepared(builder('mounts-none').command('claude').build());
    assert.equal(machineFile(renderFlyMachineRequest(plain, { config: CONFIG, launchEnvironment: {} }), FLY_RUN_FILES.mounts), undefined);
    const bare = prepared(builder('mounts-bare-tmpfs').tmpfs('/scratch', '').command('claude').build());
    assert.deepEqual(flyMachineMounts(bare), ['t\tnoexec,nosuid,nodev\t/scratch'], 'Docker\'s defaults for a tmpfs without options');
});

test('rendering refuses mount restrictions the Machine cannot enforce as declared', () => {
    const refused = (run: any, pattern: RegExp) => assert.throws(() => renderFlyMachineRequest(run, { config: CONFIG, launchEnvironment: {} }), pattern);
    refused(prepared(builder('tmpcopyup').tmpfs('/scratch', 'rw,tmpcopyup').command('c').build()), /tmpfs option "tmpcopyup" at \/scratch, which Fly Machines cannot enforce/);
    refused(prepared(builder('tmpfs-run-dir').tmpfs('/tmp', 'rw').command('c').build()), /tmpfs at \/tmp over the launcher's run directory/);

    const data = tempDir('propr-fly-mount-hidden-');
    fs.writeFileSync(path.join(data, 'file.txt'), 'x');
    const hidden = builder('tmpfs-hides-upload').bind(data, '/opt/data', false, 'data').tmpfs('/opt', 'rw').command('c').build();
    refused(prepared({ ...hidden, ...uploadAgentRunFiles(hidden).spec }), /uploads \/opt\/data under its tmpfs at \/opt/);

    const outer = tempDir('propr-fly-mount-outer-');
    const inner = tempDir('propr-fly-mount-inner-');
    fs.writeFileSync(path.join(inner, 'state.json'), '{}');
    const nested = builder('writable-in-read-only').bind(outer, '/opt/outer', true, 'data').bind(inner, '/opt/outer/inner', false, 'data').command('c').build();
    refused(prepared({ ...nested, ...uploadAgentRunFiles(nested).spec }), /uploads writable \/opt\/outer\/inner inside read-only \/opt\/outer/);

    const overRunDir = builder('read-only-run-dir').bind(outer, '/tmp', true, 'data').command('c').build();
    refused(prepared({ ...overRunDir, ...uploadAgentRunFiles(overRunDir).spec }), /mounts \/tmp read-only over the launcher's run directory/);
});

/**
 * Runs the launcher exactly as the Machine would (its script, with the
 * request's upload and mount manifests), around a trivial agent. `root`
 * simulates a root launcher: `id -u` answers 0, `chown` is a no-op and
 * `mount` records its arguments (failing for `failMount` targets).
 */
function runLauncher(request: any, options: { root: boolean; failMount?: string; user?: string }) {
    const sandbox = tempDir('propr-fly-mount-launcher-');
    const runDir = path.join(sandbox, 'run');
    fs.mkdirSync(runDir, { mode: 0o700 });
    for (const file of request.config.files) {
        const content = Buffer.from(file.raw_value, 'base64');
        const target = file.guest_path.startsWith(`${FLY_RUN_FILES.stdout.slice(0, FLY_RUN_FILES.stdout.lastIndexOf('/'))}/`)
            ? path.join(runDir, path.posix.basename(file.guest_path))
            : file.guest_path;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content, { mode: file.mode });
    }
    const bin = path.join(sandbox, 'bin');
    fs.mkdirSync(bin);
    const mountLog = path.join(sandbox, 'mount.log');
    if (options.root) {
        fs.writeFileSync(path.join(bin, 'id'), '#!/bin/bash\n[ "$*" = -u ] && { echo 0; exit 0; }\nexec /usr/bin/id "$@"\n', { mode: 0o755 });
        fs.writeFileSync(path.join(bin, 'chown'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
    }
    fs.writeFileSync(path.join(bin, 'mount'), `#!/bin/bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(mountLog)}\n`
        + (options.failMount ? `[ "\${@: -1}" = ${JSON.stringify(options.failMount)} ] && [ "$2" = remount,bind,ro ] && exit 32\n` : '')
        + 'exit 0\n', { mode: 0o755 });
    const agentMarker = path.join(sandbox, 'agent-ran');
    const [shell, ...launcherArgs] = request.config.init.entrypoint;
    const ran = spawnSync(shell, [...launcherArgs, runDir, '0', sandbox, options.user ?? '0:0', '0', '', '/bin/sh', '-c', `echo ran > ${JSON.stringify(agentMarker)}; echo agent-out`], {
        encoding: 'utf8', timeout: 30_000, env: { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: sandbox },
    });
    return {
        status: ran.status,
        agentRan: fs.existsSync(agentMarker),
        mounts: fs.existsSync(mountLog) ? fs.readFileSync(mountLog, 'utf8').trim().split('\n') : [],
        stderr: fs.readFileSync(path.join(runDir, 'stderr'), 'utf8'),
        cleanup: () => fs.rmSync(sandbox, { recursive: true, force: true }),
    };
}

test('launcher: mounts read-only uploads read-only and the tmpfs with its options before the agent starts', () => {
    const guest = tempDir('propr-fly-mount-guest-');
    const request = renderFlyMachineRequest(uploadAgentRunFiles(claudeRun(guest)).spec, { config: CONFIG, launchEnvironment: {} });
    const run = runLauncher(request, { root: true });
    try {
        assert.equal(run.status, 0, run.stderr);
        assert.equal(run.agentRan, true);
        assert.deepEqual(run.mounts, [
            `--bind ${guest}/seed/claude.json ${guest}/seed/claude.json`,
            `-o remount,bind,ro ${guest}/seed/claude.json`,
            `--bind ${guest}/data ${guest}/data`,
            `-o remount,bind,ro ${guest}/data`,
            `-t tmpfs -o noexec,nosuid,nodev,rw,nosuid,nodev,noexec,size=16m tmpfs ${guest}/claude/backups`,
        ]);
        assert.ok(fs.statSync(`${guest}/claude/backups`).isDirectory(), 'the tmpfs mount point is created');
    } finally {
        run.cleanup();
        fs.rmSync(guest, { recursive: true, force: true });
    }
});

test('launcher: a mount restriction that cannot be set up refuses the run instead of granting broader access', () => {
    const guest = tempDir('propr-fly-mount-guest-');
    const request = renderFlyMachineRequest(uploadAgentRunFiles(claudeRun(guest)).spec, { config: CONFIG, launchEnvironment: {} });
    const failing = runLauncher(request, { root: true, failMount: `${guest}/data` });
    try {
        assert.equal(failing.status, 126);
        assert.equal(failing.agentRan, false, 'the agent never starts');
        assert.match(failing.stderr, new RegExp(`propr: could not make ${guest}/data read-only`));
        assert.ok(!failing.mounts.some(line => line.startsWith('-t tmpfs')), 'nothing is mounted after the failure');
    } finally {
        failing.cleanup();
    }
    // Without root nothing can be mounted: refused, even for a run that need not start as root.
    const unprivileged = runLauncher(request, { root: false, user: '' });
    try {
        assert.equal(unprivileged.status, 126);
        assert.equal(unprivileged.agentRan, false);
        assert.match(unprivileged.stderr, /declares read-only or tmpfs mounts, which only root can set up/);
        assert.deepEqual(unprivileged.mounts, []);
    } finally {
        unprivileged.cleanup();
        fs.rmSync(guest, { recursive: true, force: true });
    }
});
