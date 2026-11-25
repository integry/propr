import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const { FLY_FORCED_STOP_SCRIPT, FLY_RUN_FILES, flyForcedStopCommand, renderFlyMachineRequest } = await import('../packages/core/src/agents/runtime/flyMachinesLaunch.ts');
const { AgentRunSpecBuilder, agentRunNetwork } = await import('../packages/core/src/agents/runtime/agentRunSpec.ts');
const {
    WORKSPACE_BOOTSTRAP_FAILURE_EXIT, WORKSPACE_TRANSPORT_ENVIRONMENT: E, WORKSPACE_TRANSPORT_SCRIPT, WORKSPACE_RESULT_BUNDLE_FILE, WORKSPACE_RESULT_PHASE_FILE, WORKSPACE_RESULT_STATUS_FILE,
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

/** Uid the processes {@link fakeProc} marks as the agent's run under (everything here really runs as one user). */
const AGENT_UID = '4242';

/**
 * A copy of `/proc` in which the given processes run as {@link AGENT_UID}:
 * every other entry links to the real one. The agent user cannot be
 * simulated otherwise without root (the test, its runner and the agent all
 * share one user ID here).
 */
function fakeProc(root: string, agentPids: number[]): string {
    const dir = path.join(root, 'proc');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir);
    for (const name of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        if (!agentPids.includes(Number(name))) { fs.symlinkSync(`/proc/${name}`, path.join(dir, name)); continue; }
        fs.mkdirSync(path.join(dir, name));
        fs.symlinkSync(`/proc/${name}/stat`, path.join(dir, name, 'stat'));
        fs.writeFileSync(path.join(dir, name, 'status'), `Name:\tagent\nUid:\t${AGENT_UID}\t${AGENT_UID}\t${AGENT_UID}\t${AGENT_UID}\n`);
    }
    return dir;
}

/**
 * The forced stop exactly as the run handle execs it in the Machine (as root there; same user here).
 * Without `agent`, no process runs as the agent user.
 */
function forcedStop(pidFile: string, phaseFile?: string, agent?: { procRoot: string }): { status: number | null; stdout: string } {
    const args = [pidFile, phaseFile ?? '', ...(agent ? [AGENT_UID, agent.procRoot] : [])];
    const ran = spawnSync('/bin/sh', ['-c', FLY_FORCED_STOP_SCRIPT, 'sh', ...args], { encoding: 'utf8', timeout: 30_000 });
    return { status: ran.status, stdout: ran.stdout.trim() };
}

function sessionOf(pid: number): number {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[3]);
}

/**
 * The agent: changes the cloned checkout, leaves a process behind (one in
 * its session, one detached that keeps writing into the checkout), then
 * ignores TERM and keeps running until it is killed.
 */
const AGENT_SCRIPT = `#!/bin/bash
trap '' TERM
echo changed > a.txt
echo new > new.txt
( trap '' TERM; while :; do sleep 0.1; done ) &
echo $! > "$LEFTOVER_PID_FILE"
# Detached into its own session (a background build server, say), still writing into the checkout.
setsid /bin/bash -c 'trap "" TERM; n=0; while :; do n=$((n + 1)); echo "$n" > detached.txt; sleep 0.02; done' < /dev/null > /dev/null 2>&1 &
echo $! > "$DETACHED_PID_FILE"
touch "$READY_FILE"
while :; do sleep 0.1; done
`;

interface CloneRun {
    launcher: ChildProcess;
    launcherExit: Promise<number | null>;
    /** Where a launcher file of {@link FLY_RUN_FILES} is in this run. */
    runFile: (file: string) => string;
    remote: string;
    resultRef: string;
    resultDir: string;
    workspace: string;
}

/**
 * A clone run's launcher, transport wrapper and agent (`agentScript`), started exactly as the Machine runs
 * them; only the run directory, a zero linger and `-c` instead of `-lc` (so the test PATH survives a login
 * shell) differ. `env` is added to the run's environment. With `SLOW_STEP` (`snapshot` or `push`) set, the
 * wrapper's finalization touches `SLOW_MARKER` and pauses `SLOW_SECONDS` at that step; with `PUSH_FAILS=1`
 * every push fails (the wrapper falls back to a bundle). `linger` is the launcher's result linger (seconds).
 */
function launchCloneRun(root: string, agentScript: string, env: Record<string, string> = {}, linger = '0'): CloneRun {
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
    const slow = (step: string) => `case " $* " in *" ${step === 'snapshot' ? 'propr-snapshot' : 'push'} "*) if [ "\${SLOW_STEP:-}" = ${step} ]; then touch "$SLOW_MARKER"; sleep "$SLOW_SECONDS"; fi ;; esac\n`;
    write(path.join(bin, 'id'), '#!/bin/bash\ncase "$*" in\n  -u) echo 0 ;;\n  node) echo "uid=1000(node)" ;;\n  "-u node") echo 1000 ;;\n  *) exec /usr/bin/id "$@" ;;\nesac\n', 0o755);
    write(path.join(bin, 'su-exec'), `#!/bin/bash\nshift\n${slow('snapshot')}exec "$@"\n`, 0o755);
    write(path.join(bin, 'chown'), '#!/bin/bash\nexit 0\n', 0o755);
    const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    write(path.join(bin, 'git'), `#!/bin/bash\n${slow('push')}case " $* " in *" push "*) [ "\${PUSH_FAILS:-}" = 1 ] && exit 1 ;; esac\nexec ${realGit} "$@"\n`, 0o755);
    if (env.PHASE_TRACE) {
        const realSync = execFileSync('/bin/sh', ['-c', 'command -v sync'], { encoding: 'utf8' }).trim();
        write(path.join(bin, 'sync'), `#!/bin/bash
[ "$#" -eq 1 ] && [ "$1" = "$PHASE_FILE.tmp" ] || exit 1
phase=$(cat "$1")
if mkdir "$PHASE_TRACE.$phase" 2>/dev/null; then
  echo "fail $phase" >> "$PHASE_TRACE"
  exit 1
fi
${realSync} "$@" || exit 1
printf 'synced ' >> "$PHASE_TRACE"
cat "$1" >> "$PHASE_TRACE"
`, 0o755);
    }
    // With PHASE_MV_PAUSE set, the wrapper's first rename that publishes that phase creates PHASE_MV_MARKER and
    // waits there until signalled or released. PAUSE_AFTER_RENAME holds it just after the rename instead.
    const realMv = execFileSync('/bin/sh', ['-c', 'command -v mv'], { encoding: 'utf8' }).trim();
    write(path.join(bin, 'mv'), `#!/bin/bash
if [ -n "\${PHASE_TRACE:-}" ] && [ "\${@: -1}" = "$PHASE_FILE" ]; then
  printf 'rename ' >> "$PHASE_TRACE"
  cat "\${@: -2:1}" >> "$PHASE_TRACE"
fi
if [ "\${FAIL_INITIAL_RENAME:-}" = 1 ] && [ "\${@: -1}" = "$PHASE_FILE" ]; then exit 1; fi
if [ -n "\${PHASE_MV_PAUSE:-}" ] && [ "\${@: -1}" = "\${PHASE_FILE:-}" ] && [ "$(cat "\${@: -2:1}")" = "$PHASE_MV_PAUSE" ] \\
    && mkdir "$PHASE_MV_MARKER" 2>/dev/null; then
  if [ "\${PAUSE_AFTER_RENAME:-}" = 1 ]; then ${realMv} "$@" || exit 1; touch "$PHASE_MV_MARKER/renamed"; fi
  while [ -d "$PHASE_MV_MARKER" ] && [ ! -e "$PHASE_MV_MARKER/release" ]; do sleep 0.05; done
  [ "\${PAUSE_AFTER_RENAME:-}" != 1 ] || exit 0
fi
exec ${realMv} "$@"
`, 0o755);
    const agent = path.join(root, 'agent.sh');
    write(agent, agentScript, 0o755);

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
    const { init } = renderFlyMachineRequest(spec, { config: { size: 'performance-1x', resultLingerSeconds: 60 }, launchEnvironment: {} }).config;
    const [shell, ...launcherArgs] = init.entrypoint!;
    const [, , workdir, user, noNewPrivileges, phaseFile, ...command] = init.cmd!;
    assert.equal(phaseFile, path.join(resultDir, WORKSPACE_RESULT_PHASE_FILE), 'the launcher is told where the wrapper records its phase');
    assert.deepEqual(command.slice(0, 2), ['/bin/bash', '-lc']);
    command[1] = '-c';
    const launcher = spawn(shell!, [...launcherArgs, runDir, linger, workdir!, user!, noNewPrivileges!, phaseFile!, ...command], {
        detached: true, stdio: 'ignore',
        env: {
            PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: root, TMPDIR: root, ...GIT_ENV, PHASE_FILE: phaseFile!, ...env,
            [E.path]: workspace, [E.remote]: remote, [E.baseRef]: baseRef, [E.baseCommit]: base,
            [E.branch]: 'task', [E.resultRef]: resultRef, [E.resultDir]: resultDir,
        },
    });
    return { launcher, launcherExit: exited(launcher), runFile: file => path.join(runDir, path.posix.basename(file)), remote, resultRef, resultDir, workspace };
}

test('forced timeout stop kills a TERM-ignoring agent and its detached processes, but keeps the clone wrapper alive to publish its changes', { timeout: 60_000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-fly-forced-stop-'));
    let launcher: ChildProcess | undefined;
    let detached = 0;
    try {
        const leftoverPidFile = path.join(root, 'leftover.pid');
        const readyFile = path.join(root, 'ready');
        const detachedPidFile = path.join(root, 'detached.pid');
        const run = launchCloneRun(root, AGENT_SCRIPT, { LEFTOVER_PID_FILE: leftoverPidFile, DETACHED_PID_FILE: detachedPidFile, READY_FILE: readyFile });
        const { launcherExit, runFile, remote, resultRef, resultDir, workspace } = run;
        launcher = run.launcher;
        await until(() => fs.existsSync(readyFile), 'the agent to change the checkout');
        assert.equal(fs.readFileSync(path.join(resultDir, WORKSPACE_RESULT_PHASE_FILE), 'utf8').trim(), 'agent');
        const leftover = Number(fs.readFileSync(leftoverPidFile, 'utf8'));
        detached = Number(fs.readFileSync(detachedPidFile, 'utf8'));
        await until(() => fs.existsSync(path.join(workspace, 'detached.txt')), 'the detached process to write');
        const leader = Number(fs.readFileSync(runFile(FLY_RUN_FILES.pid), 'utf8'));
        assert.notEqual(sessionOf(detached), sessionOf(leader), 'the detached process left the run\'s session');

        // The deadline's TERM reaches the launcher (Fly signals the main process), which forwards it; the agent ignores it.
        process.kill(launcher.pid!, 'SIGTERM');
        await new Promise(resolve => setTimeout(resolve, 500));
        assert.equal(fs.existsSync(runFile(FLY_RUN_FILES.exitStatus)), false, 'the agent ignored TERM');

        // Only the agent's own processes run as the agent user (the wrapper and launcher run as root).
        const procRoot = fakeProc(root, [detached]);
        const stopped = forcedStop(runFile(FLY_RUN_FILES.pid), path.join(resultDir, WORKSPACE_RESULT_PHASE_FILE), { procRoot });
        assert.deepEqual(stopped, { status: 0, stdout: 'killed' });
        // The script resumes the wrapper as it exits: the writer must already be dead by then.
        assert.equal(alive(detached), false, 'the detached process is dead before the wrapper resumes to finalize');
        assert.equal(await launcherExit, 137, 'the launcher exits with the killed agent\'s status (zero linger)');
        assert.equal(fs.readFileSync(runFile(FLY_RUN_FILES.exitStatus), 'utf8').trim(), '137');
        assert.equal(alive(leftover), false, 'what the agent left behind is killed too');

        const [state, snapshot] = fs.readFileSync(path.join(resultDir, WORKSPACE_RESULT_STATUS_FILE), 'utf8').trim().split(' ');
        assert.equal(state, 'pushed', 'the wrapper outlived its agent and published the workspace');
        assert.equal(git(root, '--git-dir', remote, 'rev-parse', resultRef), snapshot);
        assert.equal(git(root, '--git-dir', remote, 'show', `${resultRef}:a.txt`), 'changed');
        assert.equal(git(root, '--git-dir', remote, 'show', `${resultRef}:new.txt`), 'new');
        const written = fs.readFileSync(path.join(workspace, 'detached.txt'), 'utf8').trim();
        assert.equal(git(root, '--git-dir', remote, 'show', `${resultRef}:detached.txt`), written, 'the published snapshot is the final checkout');
        await new Promise(resolve => setTimeout(resolve, 200));
        assert.equal(fs.readFileSync(path.join(workspace, 'detached.txt'), 'utf8').trim(), written, 'nothing writes into the checkout after publication');
        assert.equal(fs.readFileSync(path.join(resultDir, WORKSPACE_RESULT_PHASE_FILE), 'utf8').trim(), 'finalizing');
    } finally {
        if (launcher?.pid) try { process.kill(-launcher.pid, 'SIGKILL'); } catch { /* already gone */ }
        if (detached) try { process.kill(detached, 'SIGKILL'); } catch { /* already gone */ }
        fs.rmSync(root, { recursive: true, force: true });
    }
});

/** An agent that changes the checkout and exits on its own (`FINISH=exit`), or keeps running until signalled. */
const CHANGING_AGENT_SCRIPT = `#!/bin/bash
echo changed > a.txt
[ "$FINISH" = exit ] && exit 0
touch "$READY_FILE"
while :; do sleep 0.1; done
`;

test('a termination signal reaches the agent but never ends the clone wrapper, also while it snapshots or publishes', { timeout: 90_000 }, async () => {
    // agent: the deadline's TERM stops the running agent; the wrapper then publishes its changes.
    // snapshot / push: the agent already exited and the wrapper is finalizing when the deadline's TERM arrives.
    for (const moment of ['agent', 'snapshot', 'push'] as const) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-fly-graceful-stop-'));
        let launcher: ChildProcess | undefined;
        try {
            const marker = path.join(root, moment === 'agent' ? 'ready' : 'finalizing');
            const run = launchCloneRun(root, CHANGING_AGENT_SCRIPT, moment === 'agent'
                ? { READY_FILE: marker, FINISH: 'run' }
                : { FINISH: 'exit', SLOW_STEP: moment, SLOW_MARKER: marker, SLOW_SECONDS: '2' });
            launcher = run.launcher;
            await until(() => fs.existsSync(marker), moment === 'agent' ? 'the agent to change the checkout' : `the wrapper to start its ${moment}`);
            const phase = () => fs.readFileSync(path.join(run.resultDir, WORKSPACE_RESULT_PHASE_FILE), 'utf8').trim();
            assert.equal(phase(), moment === 'agent' ? 'agent' : 'finalizing');
            // Fly signals the Machine's main process: the launcher.
            process.kill(launcher.pid!, 'SIGTERM');
            const expected = moment === 'agent' ? 143 : 0;
            assert.equal(await run.launcherExit, expected, `the launcher exits with the agent's own status (${moment})`);
            assert.equal(fs.readFileSync(run.runFile(FLY_RUN_FILES.exitStatus), 'utf8').trim(), String(expected));
            const [state, snapshot] = fs.readFileSync(path.join(run.resultDir, WORKSPACE_RESULT_STATUS_FILE), 'utf8').trim().split(' ');
            assert.equal(state, 'pushed', `the wrapper survived the signal and published the workspace (${moment})`);
            assert.equal(git(root, '--git-dir', run.remote, 'rev-parse', run.resultRef), snapshot);
            assert.equal(git(root, '--git-dir', run.remote, 'show', `${run.resultRef}:a.txt`), 'changed');
        } finally {
            if (launcher?.pid) try { process.kill(-launcher.pid, 'SIGKILL'); } catch { /* already gone */ }
            fs.rmSync(root, { recursive: true, force: true });
        }
    }
});

test('both phase renames wait for a successful sync of the complete temporary file', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-fly-phase-sync-'));
    try {
        const trace = path.join(root, 'phase-trace');
        const run = launchCloneRun(root, CHANGING_AGENT_SCRIPT, { PHASE_TRACE: trace, FINISH: 'exit' });
        assert.equal(await run.launcherExit, 0);
        assert.equal(fs.readFileSync(trace, 'utf8'),
            'fail agent\nsynced agent\nrename agent\nfail finalizing\nsynced finalizing\nrename finalizing\n');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('failure to publish the initial phase aborts bootstrap before the agent runs', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-fly-phase-failure-'));
    try {
        const run = launchCloneRun(root, CHANGING_AGENT_SCRIPT, { FAIL_INITIAL_RENAME: '1', FINISH: 'exit' });
        assert.equal(await run.launcherExit, WORKSPACE_BOOTSTRAP_FAILURE_EXIT);
        assert.equal(fs.readFileSync(path.join(run.resultDir, WORKSPACE_RESULT_STATUS_FILE), 'utf8'), 'failed bootstrap\n');
        assert.equal(fs.readFileSync(path.join(run.workspace, 'a.txt'), 'utf8'), 'base\n');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

for (const stop of ['TERM', 'forced'] as const) {
    for (const renamed of [false, true]) {
        test(`a ${stop} stop ${renamed ? 'after' : 'before'} the initial rename prevents agent startup`, { timeout: 30_000 }, async () => {
            const root = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-fly-phase-start-'));
            const marker = path.join(root, 'phase-mv');
            const run = launchCloneRun(root, CHANGING_AGENT_SCRIPT, {
                PHASE_MV_PAUSE: 'agent', PHASE_MV_MARKER: marker, PAUSE_AFTER_RENAME: renamed ? '1' : '0', FINISH: 'exit',
            });
            try {
                await until(() => fs.existsSync(renamed ? path.join(marker, 'renamed') : marker), 'the initial phase rename to pause');
                const phaseFile = path.join(run.resultDir, WORKSPACE_RESULT_PHASE_FILE);
                assert.equal(fs.existsSync(phaseFile), renamed);
                const pidFile = run.runFile(FLY_RUN_FILES.pid);
                if (stop === 'TERM') process.kill(run.launcher.pid!, 'SIGTERM');
                else assert.equal(forcedStop(pidFile, phaseFile).status, 0);
                const wrapper = Number(fs.readFileSync(pidFile, 'utf8'));
                await until(() => !alive(wrapper), 'the stopped wrapper to exit');
                // Bootstrap TERM can leave the paused mv holding the output pipes after its parent exits.
                write(path.join(marker, 'release'), '');
                assert.equal(await run.launcherExit, stop === 'forced' && !renamed ? 137 : 143);
                if (renamed) assert.equal(git(root, '--git-dir', run.remote, 'show', `${run.resultRef}:a.txt`), 'base');
                assert.equal(fs.readFileSync(path.join(run.workspace, 'a.txt'), 'utf8'), 'base\n');
            } finally {
                if (run.launcher.pid) try { process.kill(-run.launcher.pid, 'SIGKILL'); } catch { /* already gone */ }
                fs.rmSync(root, { recursive: true, force: true });
            }
        });
    }
}

test('a forced stop during the finalizing rename sees the complete agent phase and lets the wrapper publish', { timeout: 60_000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-fly-phase-publish-'));
    const marker = path.join(root, 'phase-mv');
    const run = launchCloneRun(root, CHANGING_AGENT_SCRIPT, { PHASE_MV_PAUSE: 'finalizing', PHASE_MV_MARKER: marker, FINISH: 'exit' });
    try {
        await until(() => fs.existsSync(marker), 'the wrapper to start publishing its finalizing phase');
        const phaseFile = path.join(run.resultDir, WORKSPACE_RESULT_PHASE_FILE);
        assert.equal(fs.readFileSync(phaseFile, 'utf8'), 'agent\n');
        assert.deepEqual(forcedStop(run.runFile(FLY_RUN_FILES.pid), phaseFile), { status: 0, stdout: 'killed' });
        assert.equal(await run.launcherExit, 0);
        assert.equal(fs.readFileSync(phaseFile, 'utf8'), 'finalizing\n');
        const [state, snapshot] = fs.readFileSync(path.join(run.resultDir, WORKSPACE_RESULT_STATUS_FILE), 'utf8').trim().split(' ');
        assert.equal(state, 'pushed');
        assert.equal(git(root, '--git-dir', run.remote, 'rev-parse', run.resultRef), snapshot);
        assert.equal(git(root, '--git-dir', run.remote, 'show', `${run.resultRef}:a.txt`), 'changed');
    } finally {
        if (run.launcher.pid) try { process.kill(-run.launcher.pid, 'SIGKILL'); } catch { /* already gone */ }
        fs.rmSync(root, { recursive: true, force: true });
    }
});

/** The agent finishes at once, leaving a changed checkout and a refreshed credential copy. */
const FINISHING_AGENT_SCRIPT = `#!/bin/bash
echo changed > a.txt
echo refreshed > "$CREDENTIAL_FILE"
echo done
exit 0
`;

test('after the run finished, a termination signal keeps its result: the launcher lingers until its end or the Machine is destroyed', { timeout: 60_000 }, async () => {
    // A deadline's or stop()'s TERM that has not seen the exit yet (its logs page was still pending), and
    // Fly's own signals, reach a launcher that is already lingering. Neither may end the linger: the
    // Machine would auto-destroy with the capture, the bundle and the refreshed credential uncollected.
    for (const retained of [false, true]) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-fly-linger-signal-'));
        let launcher: ChildProcess | undefined;
        try {
            const credential = path.join(root, 'credential.json');
            const run = launchCloneRun(root, FINISHING_AGENT_SCRIPT, { CREDENTIAL_FILE: credential, PUSH_FAILS: '1' }, '3');
            launcher = run.launcher;
            await until(() => fs.existsSync(run.runFile(FLY_RUN_FILES.exitStatus)), 'the launcher to record the exit');
            const lingerStarted = Date.now();
            if (retained) write(run.runFile(FLY_RUN_FILES.retain), '');
            for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.kill(launcher.pid!, signal);
            await new Promise(resolve => setTimeout(resolve, 500));
            assert.equal(alive(launcher.pid!), true, `the lingering launcher survives termination signals (retained: ${retained})`);
            assert.equal(fs.readFileSync(run.runFile(FLY_RUN_FILES.exitStatus), 'utf8').trim(), '0');
            assert.equal(fs.readFileSync(run.runFile(FLY_RUN_FILES.stdout), 'utf8'), 'done\n');
            assert.equal(fs.readFileSync(credential, 'utf8'), 'refreshed\n');
            assert.equal(fs.readFileSync(path.join(run.resultDir, WORKSPACE_RESULT_STATUS_FILE), 'utf8').trim().split(' ')[0], 'bundle');
            assert.ok(fs.statSync(path.join(run.resultDir, WORKSPACE_RESULT_BUNDLE_FILE)).size > 0, 'the bundle fallback is kept for the worker');
            if (!retained) {
                // Unretained, the linger still ends on its own (auto_destroy then removes the Machine).
                assert.equal(await run.launcherExit, 0);
                assert.ok(Date.now() - lingerStarted >= 2_000, 'the linger ran its course despite the signals');
            } else {
                // Retained: past its linger it keeps waiting; only the Machine's destroy (a KILL) ends it.
                await new Promise(resolve => setTimeout(resolve, 3_500));
                process.kill(launcher.pid!, 'SIGTERM');
                await new Promise(resolve => setTimeout(resolve, 200));
                assert.equal(alive(launcher.pid!), true, 'a retained run outlasts its linger and further signals');
                process.kill(launcher.pid!, 'SIGKILL');
                await run.launcherExit;
            }
        } finally {
            if (launcher?.pid) try { process.kill(-launcher.pid, 'SIGKILL'); } catch { /* already gone */ }
            fs.rmSync(root, { recursive: true, force: true });
        }
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

        // No clone transport (no phase file argument) or a wrapper still bootstrapping: the whole group goes,
        // and so does whatever the agent detached into another session.
        for (const phase of [undefined, path.join(root, 'absent-phase')]) {
            const plain = start();
            const plainChild = await childOf(leaders.length - 1);
            const detached = spawn('/bin/bash', ['-c', 'trap "" TERM; while :; do sleep 0.05; done'], { detached: true, stdio: 'ignore' });
            leaders.push(detached);
            const exit = exited(plain.leader);
            assert.equal(forcedStop(pidFile, phase, { procRoot: fakeProc(root, [detached.pid!]) }).status, 0);
            await exit;
            await until(() => !alive(plainChild), 'the group to be killed', 5_000);
            assert.equal(alive(detached.pid!), false, 'the detached agent process is killed too');
        }
    } finally {
        for (const leader of leaders) if (leader.pid) try { process.kill(-leader.pid, 'SIGKILL'); } catch { /* already gone */ }
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('the forced stop names the user the agent runs as', () => {
    const build = (user: string, clone: boolean) => {
        const spec = new AgentRunSpecBuilder({
            agentType: 'claude', image: 'propr/agent:test', name: 'claude-issue-7-abc', stdin: true, user,
            network: agentRunNetwork('bridge'),
            workspace: { hostPath: '/tmp/w', containerPath: '/home/node/workspace', readOnly: false, mode: clone ? 'clone' : 'bind' },
        }).command('claude', '-p').build();
        if (clone) spec.workspace.clone = { remote: 'r', baseRef: 'b', baseCommit: 'c', branch: 't', resultRef: 'x', resultDir: '/tmp/r/', script: 's' };
        return flyForcedStopCommand(spec);
    };
    assert.deepEqual(build('0:0', true), ['/bin/sh', '-c', FLY_FORCED_STOP_SCRIPT, 'sh', FLY_RUN_FILES.pid, '/tmp/r/phase', 'node']);
    assert.deepEqual(build('1000:1000', false).slice(3), ['sh', FLY_RUN_FILES.pid, '', '1000']);
    assert.deepEqual(build('root', false).slice(3), ['sh', FLY_RUN_FILES.pid, '', 'node'], 'a root run\'s provider entrypoint drops the agent to node');
});
