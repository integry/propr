import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { FlyMachinesRuntime } from '../packages/core/src/agents/runtime/flyMachinesRuntime.ts';
import { AgentRunSpecBuilder, agentRunNetwork } from '../packages/core/src/agents/runtime/agentRunSpec.ts';
import { agentRuntimePackageInstallCommand, agentRuntimePackagesLogFields } from '../packages/core/src/agents/runtime/agentRuntimePackageProfile.ts';
import { formatComputeUsage, normalizeComputeUsage } from '../packages/core/src/agents/runtime/computeUsage.ts';
import type { MachineLaunch, MachinesApi } from '../packages/core/src/agents/runtime/fly/api.ts';
import { RUN, wrapper } from '../packages/core/src/agents/runtime/fly/wrapper.ts';
import { WORKSPACE_TRANSPORT_RESULT_DIR as RESULT, WORKSPACE_TRANSPORT_SCRIPT } from '../packages/core/src/git/workspaceTransportScript.ts';
import { closeConnection } from '../packages/core/src/db/connection.ts';

after(closeConnection);

const env = { PROPR_FLY_APP: 'agents', PROPR_FLY_API_TOKEN: 'FlyV1 synthetic-worker-credential', PROPR_FLY_IMAGE: 'registry.fly.io/agents@sha256:test' };

/** A Machine whose wrapper reports `installing` for `installPolls` probes, then the install outcome. */
class InstallingMachine implements MachinesApi {
    launch?: MachineLaunch;
    files = new Map<string, Buffer>([
        [RUN + '/stdout', Buffer.from('agent output\n')],
        [RUN + '/stderr', Buffer.alloc(0)],
        [RUN + '/workspace/status', Buffer.from('bundle test')],
        [RUN + '/workspace/result.bundle', Buffer.from([0, 255, 42])],
    ]);
    commands: string[][] = [];
    started = false;
    destroyed = 0;
    constructor(private installPolls: number, private readonly install?: { ms: number; code: number | 'timeout'; tail: string }) {}
    async create(launch: MachineLaunch) { this.launch = launch; return 'machine'; }
    async logs() {}
    async exec(_id: string, args: string[]) {
        this.commands.push(args);
        if (args[0] === '/usr/bin/touch') {
            if (args[1] === RUN + '/start') this.started = true;
            return { stdout: '', exit_code: 0 };
        }
        if (args[0] === '/bin/cat') {
            assert.equal(args[1], RUN + '/packages-result');
            return this.install ? { stdout: JSON.stringify(this.install), exit_code: 0 } : { stdout: '', exit_code: 1 };
        }
        const [op, file, offset, length] = args.slice(3);
        if (op === 'probe') {
            if (this.installPolls > 0) { this.installPolls--; return { stdout: 'installing\n0', exit_code: 0 }; }
            if (this.install && this.install.code !== 0) return { stdout: 'install-failed\n0', exit_code: 0 };
            return { stdout: (this.started ? 'exited 0' : 'ready') + '\n0', exit_code: 0 };
        }
        const data = this.files.get(file);
        if (op === 'size') return { stdout: String(data?.length), exit_code: data ? 0 : 44 };
        assert.equal(op, 'chunk');
        return { stdout: data!.subarray(+offset, +offset + +length).toString('base64'), exit_code: 0 };
    }
    async signal() {}
    async destroy() { this.destroyed++; }
    file(name: string) {
        const entry = this.launch!.config.files.find(f => f.guest_path === RUN + '/' + name);
        return entry && JSON.parse(Buffer.from(entry.raw_value, 'base64').toString());
    }
}

function spec() {
    return new AgentRunSpecBuilder({
        agentType: 'claude', image: 'propr/agent', name: 'task', stdin: true, user: '0:0', network: agentRunNetwork('bridge'),
        workspace: { hostPath: '/unused', containerPath: '/home/node/workspace', readOnly: false, mode: 'clone',
            clone: { remote: 'unused', baseRef: 'base', baseCommit: '0123', branch: 'test', resultDir: RESULT, script: WORKSPACE_TRANSPORT_SCRIPT } },
    }).command('claude', '--version').build();
}

test('without configured packages a Fly Machine gets no install step', async () => {
    const api = new InstallingMachine(0);
    const run = new FlyMachinesRuntime(api, env, async () => []).start(spec());
    const result = await run.wait();
    assert.equal(result.exitCode, 0);
    assert.equal(api.file('packages.json'), undefined, 'no apt step for the default case');
    assert.ok(!api.commands.some(args => args[0] === '/bin/cat'));
    // Every Fly run reports compute time on the same basis, from dispatch; nothing package-related without packages.
    assert.equal(result.computeUsage?.runtime, 'fly-machines');
    assert.ok(result.computeUsage!.wallTimeMs >= result.computeUsage!.provisioningMs!);
    assert.equal(result.computeUsage?.packageInstallMs, undefined);
    assert.equal(result.computeUsage?.imageWaitMs, undefined);
    await run.release!();
});

test('a Fly Machine installs the packages as root before the agent starts and records the install time', async () => {
    const api = new InstallingMachine(3, { ms: 42_000, code: 0, tail: 'Setting up postgresql-client' });
    const run = new FlyMachinesRuntime(api, env, async () => ['postgresql-client']).start(spec());
    const result = await run.wait();
    assert.equal(result.exitCode, 0);
    const install = api.file('packages.json');
    // Same argv as the Sprites install: specs as positional arguments, no shell interpolation.
    assert.deepEqual(install.argv, agentRuntimePackageInstallCommand(['postgresql-client']));
    assert.equal(install.timeout, 15 * 60_000);
    // The wrapper runs as root and installs before reporting ready, so the start gate opens only afterwards.
    assert.equal(api.launch!.config.processes[0].user, 'root');
    const cat = api.commands.findIndex(args => args[0] === '/bin/cat');
    const start = api.commands.findIndex(args => args[0] === '/usr/bin/touch' && args[1] === RUN + '/start');
    assert.ok(cat >= 0 && cat < start, 'the install record is read before the agent starts');
    assert.equal(result.computeUsage?.packageInstallMs, 42_000);
    // Provisioning is measured by the worker (dispatch to agent start); the install and image wait are their own fields.
    assert.equal(typeof result.computeUsage?.provisioningMs, 'number');
    assert.equal(typeof result.computeUsage?.imageWaitMs, 'number');
    assert.equal(normalizeComputeUsage(JSON.parse(JSON.stringify(result.computeUsage)))?.packageInstallMs, 42_000);
    assert.match(formatComputeUsage(result.computeUsage!), /42s installing packages/);
    await run.release!();
});

test('a failed install fails the run with the end of apt output and never starts the agent', async () => {
    const api = new InstallingMachine(1, { ms: 3_000, code: 100, tail: 'Reading package lists...\nE: Unable to locate package postgresql-clent' });
    const run = new FlyMachinesRuntime(api, env, async () => ['postgresql-clent']).start(spec());
    await assert.rejects(run.wait(), (error: Error) => {
        assert.match(error.message, /could not install the agent runtime packages \(digest [0-9a-f]{16}\): apt exited with code 100 after 3s/);
        assert.match(error.message, /E: Unable to locate package postgresql-clent$/);
        assert.match(error.message, /not started without them/);
        return true;
    });
    assert.equal(api.started, false, 'the agent never starts without its packages');
    assert.ok(api.commands.some(args => args[0] === '/usr/bin/touch' && args[1] === RUN + '/packages-read'));
    assert.equal(api.destroyed, 1);
});

test('an unreadable package list fails the Fly run before a Machine is created', async () => {
    const api = new InstallingMachine(0);
    const run = new FlyMachinesRuntime(api, env, async () => { throw new Error('Configured agent runtime packages are invalid'); }).start(spec());
    await assert.rejects(run.wait(), /invalid/);
    assert.equal(api.launch, undefined);
});

test('the log fields carry the digest and count, and the names only for a short list', () => {
    const short = agentRuntimePackagesLogFields(['jq', 'postgresql-client']);
    assert.deepEqual(short.packages, ['jq', 'postgresql-client']);
    assert.equal(short.packageCount, 2);
    assert.match(short.packagesDigest, /^[0-9a-f]{16}$/);
    const long = agentRuntimePackagesLogFields(['a', 'b', 'c', 'd', 'e', 'f']);
    assert.equal(long.packages, undefined);
    assert.equal(long.packageCount, 6);
});

function runInstall(argv: string[], timeout: number) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fly-packages-'));
    try {
        // The worker acknowledges a failure by creating packages-read; pre-create it so the wrapper does not wait.
        fs.writeFileSync(path.join(root, 'packages-read'), '');
        const ok = execFileSync('python3', ['-I', '-c', wrapper + `
run = Path(sys.argv[1])
print(install_packages({'argv': json.loads(sys.argv[2]), 'path': os.environ['PATH'], 'timeout': int(sys.argv[3])}))
`, root, JSON.stringify(argv), String(timeout)], { encoding: 'utf8' }).trim();
        return { ok, status: fs.readFileSync(path.join(root, 'status'), 'utf8').trim(),
            result: JSON.parse(fs.readFileSync(path.join(root, 'packages-result'), 'utf8')) };
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('the wrapper install records its duration and exit, keeps the output tail and enforces its time limit', () => {
    const ok = runInstall(['/bin/sh', '-c', 'echo installed "$@"', 'sh', 'postgresql-client'], 10_000);
    assert.equal(ok.ok, 'True');
    assert.equal(ok.status, 'installing', 'success leaves the status for the ready report that follows');
    assert.equal(ok.result.code, 0);
    assert.match(ok.result.tail, /installed postgresql-client/);
    assert.ok(Number.isInteger(ok.result.ms));

    const failed = runInstall(['/bin/sh', '-c', 'echo E: Unable to locate package nope >&2; exit 100'], 10_000);
    assert.equal(failed.ok, 'False');
    assert.equal(failed.status, 'install-failed');
    assert.equal(failed.result.code, 100);
    assert.match(failed.result.tail, /E: Unable to locate package nope/);

    const slow = runInstall(['/bin/sh', '-c', 'echo started; exec sleep 30'], 300);
    assert.equal(slow.status, 'install-failed');
    assert.equal(slow.result.code, 'timeout');
    assert.match(slow.result.tail, /started/);
    assert.ok(slow.result.ms < 10_000, 'the install is killed at its time limit');
});
