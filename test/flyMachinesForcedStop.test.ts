import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const { FLY_FORCED_STOP_SCRIPT, FLY_RUN_FILES, renderFlyMachineRequest } = await import('../packages/core/src/agents/runtime/flyMachinesLaunch.ts');
const { AgentRunSpecBuilder, agentRunNetwork } = await import('../packages/core/src/agents/runtime/agentRunSpec.ts');
const {
    WORKSPACE_TRANSPORT_ENVIRONMENT: E, WORKSPACE_TRANSPORT_SCRIPT, WORKSPACE_RESULT_PHASE_FILE, WORKSPACE_RESULT_STATUS_FILE,
} = await import('../packages/core/src/git/workspaceTransportScript.ts');

const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1' };

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trimEnd();
}

function write(file: string, content: string, mode?: number): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, mode ? { mode } : undefined);
}

function alive(pid: number): boolean {
    try { process.kill(pid, 0); } catch { return false; }
    // A zombie no longer runs.
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2)[0] !== 'Z';
}

function processState(pid: number): string {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2)[0]!;
}

async function until(condition: () => boolean, what: string, ms = 20_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise(resolve => setTimeout(resolve, 20));
    }
}

function exited(child: ChildProcess): Promise<number | null> {
    return new Promise(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode);
        else child.on('exit', code => resolve(code));
    });
}

/** The forced stop exactly as the run handle execs it in the Machine (as root there; same user here). */
function forcedStop(pidFile: string, phaseFile?: string): { status: number | null; stdout: string } {
    const ran = spawnSync('/bin/sh', ['-c', FLY_FORCED_STOP_SCRIPT, 'sh', pidFile, ...(phaseFile ? [phaseFile] : [])], { encoding: 'utf8', timeout: 30_000 });
    return { status: ran.status, stdout: ran.stdout.trim() };
}

/**
 * The agent: changes the cloned checkout, leaves a process behind, then
 * ignores TERM and keeps running until it is killed.
 */
const AGENT_SCRIPT = `#!/bin/bash
trap '' TERM
echo changed > a.txt
echo new > new.txt
( trap '' TERM; while :; do sleep 0.1; done ) &
echo $! > "$LEFTOVER_PID_FILE"
touch "$READY_FILE"
while :; do sleep 0.1; done
`;

test('forced timeout stop kills a TERM-ignoring agent but keeps the clone wrapper alive to publish its changes', { timeout: 60_000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-fly-forced-stop-'));
    let launcher: ChildProcess | undefined;
    try {
        const remote = path.join(root, 'remote.git');
        const seed = path.join(root, 'seed');
        git(root, 'init', '-q', '--bare', '-b', 'main', remote);
        git(root, 'init', '-q', '-b', 'main', seed);
        write(path.join(seed, 'a.txt'), 'base\n');
        git(seed, 'add', '-A');
        git(seed, 'commit', '-q', '-m', 'seed');
        const base = git(seed, 'rev-parse', 'HEAD');
        const baseRef = 'refs/propr/runs/x/base';
        const resultRef = 'refs/propr/runs/x/result';
        git(seed, 'push', '-q', remote, `${base}:${baseRef}`);

        // The Machine's identities, simulated (no root here): `id` reports root and a separate `node` user,
        // `su-exec` drops to "node" by just running the command.
        const bin = path.join(root, 'bin');
        write(path.join(bin, 'id'), '#!/bin/bash\ncase "$*" in\n  -u) echo 0 ;;\n  node) echo "uid=1000(node)" ;;\n  "-u node") echo 1000 ;;\n  *) exec /usr/bin/id "$@" ;;\nesac\n', 0o755);
        write(path.join(bin, 'su-exec'), '#!/bin/bash\nshift\nexec "$@"\n', 0o755);
        write(path.join(bin, 'chown'), '#!/bin/bash\nexit 0\n', 0o755);
        const agent = path.join(root, 'agent.sh');
        write(agent, AGENT_SCRIPT, 0o755);

        const runDir = path.join(root, 'fly-run');
        const resultDir = path.join(root, 'result');
        const workspace = path.join(root, 'workspace');
        const spec = new AgentRunSpecBuilder({
            agentType: 'claude', image: 'propr/agent:test', name: 'claude-issue-7-abc', stdin: true, user: '0:0',
            network: agentRunNetwork('bridge'),
            workspace: { hostPath: '/tmp/w', containerPath: workspace, readOnly: false, mode: 'clone' },
        }).command('claude', '-p').build();
        spec.entrypoint = agent;
        spec.workspace.clone = { remote, baseRef, baseCommit: base, branch: 'task', resultRef, resultDir, script: WORKSPACE_TRANSPORT_SCRIPT };
        // The launcher and command chain exactly as the Machine runs them; only the run directory, a zero linger
        // and `-c` instead of `-lc` (so the test PATH survives a login shell) differ.
        const { init } = renderFlyMachineRequest(spec, { config: { size: 'performance-1x', resultLingerSeconds: 60 }, launchEnvironment: {} }).config;
        const [shell, ...launcherArgs] = init.entrypoint!;
        const [, , workdir, user, noNewPrivileges, ...command] = init.cmd!;
        assert.deepEqual(command.slice(0, 2), ['/bin/bash', '-lc']);
        command[1] = '-c';
        const leftoverPidFile = path.join(root, 'leftover.pid');
        const readyFile = path.join(root, 'ready');
        launcher = spawn(shell!, [...launcherArgs, runDir, '0', workdir!, user!, noNewPrivileges!, ...command], {
            detached: true, stdio: 'ignore',
            env: {
                PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: root, TMPDIR: root, ...GIT_ENV,
                LEFTOVER_PID_FILE: leftoverPidFile, READY_FILE: readyFile,
                [E.path]: workspace, [E.remote]: remote, [E.baseRef]: baseRef, [E.baseCommit]: base,
                [E.branch]: 'task', [E.resultRef]: resultRef, [E.resultDir]: resultDir,
            },
        });
        const launcherExit = exited(launcher);
        const runFile = (file: string) => path.join(runDir, path.posix.basename(file));
        await until(() => fs.existsSync(readyFile), 'the agent to change the checkout');
        assert.equal(fs.readFileSync(path.join(resultDir, WORKSPACE_RESULT_PHASE_FILE), 'utf8').trim(), 'agent');
        const leftover = Number(fs.readFileSync(leftoverPidFile, 'utf8'));

        // The deadline's TERM reaches the launcher (Fly signals the main process), which forwards it; the agent ignores it.
        process.kill(launcher.pid!, 'SIGTERM');
        await new Promise(resolve => setTimeout(resolve, 500));
        assert.equal(fs.existsSync(runFile(FLY_RUN_FILES.exitStatus)), false, 'the agent ignored TERM');

        const stopped = forcedStop(runFile(FLY_RUN_FILES.pid), path.join(resultDir, WORKSPACE_RESULT_PHASE_FILE));
        assert.deepEqual(stopped, { status: 0, stdout: 'killed' });
        assert.equal(await launcherExit, 137, 'the launcher exits with the killed agent\'s status (zero linger)');
        assert.equal(fs.readFileSync(runFile(FLY_RUN_FILES.exitStatus), 'utf8').trim(), '137');
        assert.equal(alive(leftover), false, 'what the agent left behind is killed too');

        const [state, snapshot] = fs.readFileSync(path.join(resultDir, WORKSPACE_RESULT_STATUS_FILE), 'utf8').trim().split(' ');
        assert.equal(state, 'pushed', 'the wrapper outlived its agent and published the workspace');
        assert.equal(git(root, '--git-dir', remote, 'rev-parse', resultRef), snapshot);
        assert.equal(git(root, '--git-dir', remote, 'show', `${resultRef}:a.txt`), 'changed');
        assert.equal(git(root, '--git-dir', remote, 'show', `${resultRef}:new.txt`), 'new');
        assert.equal(fs.readFileSync(path.join(resultDir, WORKSPACE_RESULT_PHASE_FILE), 'utf8').trim(), 'finalizing');
    } finally {
        if (launcher?.pid) try { process.kill(-launcher.pid, 'SIGKILL'); } catch { /* already gone */ }
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('forced stop spares a finalizing clone wrapper, and kills the whole group of a run without one', { timeout: 30_000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-fly-forced-stop-'));
    const leaders: ChildProcess[] = [];
    try {
        const pidFile = path.join(root, 'pid');
        const phaseFile = path.join(root, 'phase');
        const start = (): { leader: ChildProcess; child: number } => {
            const childFile = path.join(root, `child-${leaders.length}`);
            // Its own session, as the launcher's setsid starts the command chain.
            const leader = spawn('/bin/bash', ['-c', 'sleep 30 & echo $! > "$1"; wait', 'leader', childFile], { detached: true, stdio: 'ignore' });
            leaders.push(leader);
            write(pidFile, `${leader.pid}\n`);
            return { leader, child: 0 };
        };
        const childOf = async (index: number): Promise<number> => {
            const file = path.join(root, `child-${index}`);
            await until(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim() !== '', 'the leader to start its child');
            return Number(fs.readFileSync(file, 'utf8'));
        };

        // The wrapper is snapshotting/publishing: nothing is killed, and it is not left stopped.
        const finalizing = start();
        const finalizingChild = await childOf(0);
        write(phaseFile, 'finalizing\n');
        assert.deepEqual(forcedStop(pidFile, phaseFile), { status: 0, stdout: 'finalizing' });
        assert.equal(alive(finalizing.leader.pid!), true);
        assert.equal(alive(finalizingChild), true, 'the finalization work keeps running');
        assert.notEqual(processState(finalizing.leader.pid!), 'T', 'the wrapper is resumed');

        // No clone transport (no phase file argument) or a wrapper still bootstrapping: the whole group goes.
        for (const phase of [undefined, path.join(root, 'absent-phase')]) {
            const plain = start();
            const plainChild = await childOf(leaders.length - 1);
            const exit = exited(plain.leader);
            assert.equal(forcedStop(pidFile, phase).status, 0);
            await exit;
            await until(() => !alive(plainChild), 'the group to be killed', 5_000);
        }
    } finally {
        for (const leader of leaders) if (leader.pid) try { process.kill(-leader.pid, 'SIGKILL'); } catch { /* already gone */ }
        fs.rmSync(root, { recursive: true, force: true });
    }
});
