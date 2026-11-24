import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

type Call = { command: string; args: string[]; options: Record<string, any> };
const calls: Call[] = [];
let duringRun: (call: Call) => void = () => {};

await mock.module('../packages/core/src/claude/docker/dockerExecutor.js', {
    namedExports: {
        executeDockerCommand: async (command: string, args: string[], options: Record<string, any> = {}) => {
            const call = { command, args, options };
            calls.push(call);
            duringRun(call);
            return { stdout: '', stderr: '', exitCode: 0, messageTimestamps: new Map() };
        },
    },
});

const { CredentialBroker } = await import('../packages/core/src/agents/credentials/broker.ts');
const { providerCredentialManifests, refreshableCredentialPaths } = await import('../packages/core/src/agents/credentials/providerManifests.ts');
const { withCredentialStoreLock, credentialStoreLockPath, CredentialStoreLockTimeoutError } = await import('../packages/core/src/agents/credentials/credentialStoreLock.ts');
const {
    stageAgentRunCredentials, resolveCredentialBrokerMode, credentialRunRoot, AGENT_CREDENTIAL_BROKER_ENV, AGENT_CREDENTIAL_RUN_DIR_ENV,
    sweepStaleStaging, STALE_STAGING_LEASE_MS, STAGING_LEASE_FILE, STAGING_RETAINED_FILE,
} = await import('../packages/core/src/agents/credentials/hostCredentialStaging.ts');
const { AgentRunSpecBuilder, agentRunNetwork } = await import('../packages/core/src/agents/runtime/agentRunSpec.ts');
const { renderDockerRunArgs } = await import('../packages/core/src/agents/runtime/dockerRunArgs.ts');
const { runAgent } = await import('../packages/core/src/agents/runtime/registry.ts');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-credential-broker-'));
const runRoot = path.join(scratch, 'runs');
const brokerEnvironment = { [AGENT_CREDENTIAL_RUN_DIR_ENV]: runRoot };
process.env[AGENT_CREDENTIAL_RUN_DIR_ENV] = runRoot;
delete process.env[AGENT_CREDENTIAL_BROKER_ENV];
delete process.env.PROPR_MANAGED_LOGS;
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

let storeCounter = 0;
function makeStore(files: Record<string, string>, modes: Record<string, number> = {}): string {
    const root = path.join(scratch, `store-${storeCounter++}`);
    for (const [relative, content] of Object.entries(files)) {
        const target = path.join(root, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content, { mode: modes[relative] ?? 0o600 });
        fs.chmodSync(target, modes[relative] ?? 0o600);
    }
    fs.mkdirSync(root, { recursive: true });
    return root;
}

function listFiles(root: string, prefix = ''): string[] {
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        return entry.isDirectory() ? listFiles(path.join(root, entry.name), relative) : [relative];
    }).sort();
}

type Provider = 'claude' | 'codex' | 'antigravity' | 'opencode' | 'vibe';
function specWith(stores: Array<{ provider: Provider; store?: 'config' | 'data'; source: string; target: string; readOnly?: boolean; perRun?: boolean }>, env: Record<string, string | undefined> = {}) {
    const builder = new AgentRunSpecBuilder({
        agentType: stores[0].provider, image: 'propr/agent:test', name: `${stores[0].provider}-issue-1-abc`, stdin: true,
        network: agentRunNetwork('bridge'),
        workspace: { hostPath: '/tmp/w', containerPath: '/home/node/workspace', readOnly: false },
    }).workspaceMount();
    for (const store of stores) {
        builder.credentialBind(store.source, store.target, store.readOnly ?? false, { provider: store.provider, store: store.store ?? 'config', perRun: store.perRun ?? true });
    }
    for (const [name, value] of Object.entries(env)) builder.env(name, value);
    return builder.command('agent').build();
}

function stagedSource(spec: ReturnType<typeof specWith>, target: string): string {
    const mount = spec.mounts.find(candidate => candidate.type === 'bind' && candidate.target === target);
    assert.ok(mount && mount.type === 'bind');
    return mount.source;
}

/** Simulates a CLI refreshing a token inside the run: new content, a later mtime. */
function refreshIn(stagedStore: string, relative: string, content: string, mtimeMs = Date.now() + 1_000): void {
    const target = path.join(stagedStore, relative);
    fs.writeFileSync(target, content);
    fs.utimesSync(target, mtimeMs / 1000, mtimeMs / 1000);
}

const roundTrips: Array<{ provider: Provider; store?: 'config' | 'data'; target: string; token: string; config: Record<string, string>; noise: Record<string, string> }> = [
    {
        provider: 'claude', target: '/home/node/.claude', token: '.credentials.json',
        config: { 'settings.json': '{"theme":"dark"}', 'commands/review.md': '# review' },
        noise: { 'projects/home-node-workspace/s1.jsonl': '{}', 'todos/a.json': '[]', 'statsig/cache': 'x', 'history.jsonl': '{}' },
    },
    {
        provider: 'codex', target: '/home/node/.codex', token: 'auth.json',
        config: { 'config.toml': 'model = "gpt"', 'AGENTS.md': '# agents' },
        noise: { 'sessions/2026/11/rollout.jsonl': '{}', 'history.jsonl': '{}', 'log/codex.log': 'log' },
    },
    {
        provider: 'antigravity', target: '/home/node/.gemini-source', token: 'antigravity-cli/antigravity-oauth-token',
        config: { 'antigravity-cli/settings.json': '{}' },
        noise: { 'antigravity-cli/brain/x/transcript.jsonl': '{}', 'oauth_backup.json': '{}', 'tmp/cache': 'x' },
    },
    {
        provider: 'opencode', store: 'data', target: '/home/node/.local/share/opencode-source', token: 'auth.json',
        config: {},
        noise: { 'storage/session/x.json': '{}', 'log/opencode.log': 'log', 'bin/rg': 'binary' },
    },
];

for (const scenario of roundTrips) {
    test(`token refresh round trip: ${scenario.provider} ${scenario.store ?? 'config'}`, async () => {
        const original = `{"token":"${scenario.provider}-old"}`;
        const root = makeStore({ [scenario.token]: original, ...scenario.config, ...scenario.noise });
        const spec = specWith([{ provider: scenario.provider, store: scenario.store, source: root, target: scenario.target }]);
        const staged = stageAgentRunCredentials(spec, { environment: brokerEnvironment });
        assert.ok(staged, 'per-run staging is the default');
        const storeDir = stagedSource(staged.spec, scenario.target);
        assert.notEqual(storeDir, root);
        assert.ok(storeDir.startsWith(runRoot + path.sep));
        // Only the manifest's files reach the run; sessions, history and logs stay on the host.
        assert.deepEqual(listFiles(storeDir), [scenario.token, ...Object.keys(scenario.config)].sort());
        assert.equal(fs.statSync(path.join(storeDir, scenario.token)).mode & 0o777, 0o600);
        assert.ok(renderDockerRunArgs(staged.spec).includes(`${storeDir}:${scenario.target}:rw`));

        // The CLI refreshes its token, edits config and writes new state inside the run.
        refreshIn(storeDir, scenario.token, `{"token":"${scenario.provider}-new"}`);
        const configFile = Object.keys(scenario.config)[0];
        if (configFile) fs.writeFileSync(path.join(storeDir, configFile), 'tampered');
        fs.mkdirSync(path.join(storeDir, 'planted'), { recursive: true });
        fs.writeFileSync(path.join(storeDir, 'planted', 'evil.sh'), 'rm -rf /');

        const results = await staged.complete();
        assert.deepEqual(results.filter(result => result.outcome !== 'unchanged').map(result => [result.path, result.outcome]), [[scenario.token, 'written']]);
        assert.equal(fs.readFileSync(path.join(root, scenario.token), 'utf8'), `{"token":"${scenario.provider}-new"}`);
        assert.equal(fs.statSync(path.join(root, scenario.token)).mode & 0o777, 0o600);
        // Nothing but refreshable token files is written back.
        if (configFile) assert.equal(fs.readFileSync(path.join(root, configFile), 'utf8'), scenario.config[configFile]);
        assert.equal(fs.existsSync(path.join(root, 'planted')), false);
        assert.equal(fs.existsSync(path.dirname(storeDir)), false, 'the staged copy is removed after the run');
    });
}

test('token refresh round trip: vibe reads config read-only and receives its .env key as a secret variable', async () => {
    const root = makeStore({ 'config.toml': 'active_model = "m"', '.env': 'export MISTRAL_API_KEY="mk-secret-123"\nOTHER=1\n', 'sessions/s.json': '{}', 'logs/v.log': 'x' });
    const spec = specWith([{ provider: 'vibe', source: root, target: '/home/node/.vibe', readOnly: true }]);
    const staged = stageAgentRunCredentials(spec, { environment: brokerEnvironment });
    assert.ok(staged);
    const storeDir = stagedSource(staged.spec, '/home/node/.vibe');
    assert.deepEqual(listFiles(storeDir), ['config.toml']);
    assert.deepEqual(staged.secretEnv, { MISTRAL_API_KEY: 'mk-secret-123' });
    const args = renderDockerRunArgs(staged.spec);
    assert.ok(args.includes(`${storeDir}:/home/node/.vibe:ro`));
    assert.ok(args.includes('MISTRAL_API_KEY'), 'the key is passed by name');
    assert.ok(!args.some(arg => arg.includes('mk-secret-123')), 'the key value never appears in argv');
    assert.deepEqual(await staged.complete(), []);
    assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8').includes('mk-secret-123'), true);
});

test('API-key runs do not receive the OAuth token file, and secret files never override run variables', () => {
    const root = makeStore({ '.credentials.json': '{"oauth":1}', 'settings.json': '{}' });
    const staged = stageAgentRunCredentials(specWith([{ provider: 'claude', source: root, target: '/home/node/.claude' }], { ANTHROPIC_API_KEY: 'sk-ant' }), { environment: brokerEnvironment });
    assert.ok(staged);
    assert.deepEqual(listFiles(stagedSource(staged.spec, '/home/node/.claude')), ['settings.json']);
    assert.deepEqual(staged.bundle.stores[0].outputs, []);
    assert.deepEqual(staged.bundle.stores[0].skipped, [{ path: '.credentials.json', reason: 'api-key-env' }]);
    void staged.complete();

    const vibeRoot = makeStore({ '.env': 'MISTRAL_API_KEY=from-file', 'config.toml': '' });
    const vibe = stageAgentRunCredentials(specWith([{ provider: 'vibe', source: vibeRoot, target: '/home/node/.vibe', readOnly: true }], { MISTRAL_API_KEY: 'from-agent' }), { environment: brokerEnvironment });
    assert.ok(vibe);
    assert.deepEqual(vibe.secretEnv, {});
    void vibe.complete();
});

test('feature flag: legacy keeps the direct mount; managed native diagnostics default to legacy', () => {
    const root = makeStore({ 'auth.json': '{}' });
    const spec = specWith([{ provider: 'codex', source: root, target: '/home/node/.codex' }]);
    assert.equal(stageAgentRunCredentials(spec, { environment: { ...brokerEnvironment, [AGENT_CREDENTIAL_BROKER_ENV]: 'legacy' } }), undefined);
    assert.equal(resolveCredentialBrokerMode({}), 'per-run');
    assert.equal(resolveCredentialBrokerMode({ PROPR_MANAGED_LOGS: '1' }), 'legacy');
    assert.equal(resolveCredentialBrokerMode({ PROPR_MANAGED_LOGS: '1', [AGENT_CREDENTIAL_BROKER_ENV]: 'per-run' }), 'per-run');
    assert.throws(() => resolveCredentialBrokerMode({ [AGENT_CREDENTIAL_BROKER_ENV]: 'maybe' }), /per-run" or "legacy/);
    assert.equal(credentialRunRoot({ PROPR_MANAGED_CREDENTIALS_DIR: '/data/creds' }), '/data/creds/.propr-runs');
    // Session-persistent runs (goal resume) keep the direct mount whatever the mode.
    assert.equal(stageAgentRunCredentials(specWith([{ provider: 'codex', source: root, target: '/home/node/.codex', perRun: false }]), { environment: brokerEnvironment }), undefined);
});

test('concurrent runs: the most recently refreshed token wins regardless of completion order', async () => {
    for (const order of ['older-first', 'newer-first'] as const) {
        const root = makeStore({ 'auth.json': 'v0' });
        const baseTime = Date.now();
        const older = stageAgentRunCredentials(specWith([{ provider: 'codex', source: root, target: '/home/node/.codex' }]), { environment: brokerEnvironment })!;
        const newer = stageAgentRunCredentials(specWith([{ provider: 'codex', source: root, target: '/home/node/.codex' }]), { environment: brokerEnvironment })!;
        refreshIn(stagedSource(older.spec, '/home/node/.codex'), 'auth.json', 'v-older', baseTime + 10_000);
        refreshIn(stagedSource(newer.spec, '/home/node/.codex'), 'auth.json', 'v-newer', baseTime + 20_000);
        const [first, second] = order === 'older-first' ? [older, newer] : [newer, older];
        const firstResults = await first.complete();
        const secondResults = await second.complete();
        assert.equal(fs.readFileSync(path.join(root, 'auth.json'), 'utf8'), 'v-newer', order);
        assert.equal(firstResults[0].outcome, 'written');
        assert.equal(secondResults[0].outcome, order === 'older-first' ? 'written-newer' : 'kept-canonical');
    }
});

test('concurrent completions in parallel serialise on the store lock', async () => {
    const root = makeStore({ '.credentials.json': 'v0' });
    const runs = Array.from({ length: 6 }, () => stageAgentRunCredentials(specWith([{ provider: 'claude', source: root, target: '/home/node/.claude' }]), { environment: brokerEnvironment })!);
    const base = Date.now();
    runs.forEach((run, index) => refreshIn(stagedSource(run.spec, '/home/node/.claude'), '.credentials.json', `v${index + 1}`, base + (index + 1) * 1_000));
    await Promise.all(runs.reverse().map(run => run.complete()));
    assert.equal(fs.readFileSync(path.join(root, '.credentials.json'), 'utf8'), 'v6');
    assert.deepEqual(fs.readdirSync(path.join(runRoot, '.locks')), [], 'locks are released');
});

test('store lock: waits for a live holder, breaks a stale one, times out otherwise', async () => {
    const lockRoot = path.join(scratch, 'locks');
    const store = makeStore({});
    fs.mkdirSync(lockRoot, { recursive: true });
    const lockPath = credentialStoreLockPath(lockRoot, store);
    fs.writeFileSync(lockPath, 'other-worker');
    await assert.rejects(withCredentialStoreLock(store, { lockRoot, timeoutMs: 100, pollMs: 10 }, () => 1), CredentialStoreLockTimeoutError);
    const old = (Date.now() - 120_000) / 1000;
    fs.utimesSync(lockPath, old, old);
    assert.equal(await withCredentialStoreLock(store, { lockRoot, timeoutMs: 1_000, pollMs: 10 }, () => 'ran'), 'ran');
    assert.equal(fs.existsSync(lockPath), false);
});

test('symlinks in the store are neither copied nor written through', async () => {
    const outside = makeStore({ 'secret.txt': 'host secret' });
    const root = makeStore({ 'config.toml': '' });
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'auth.json'));
    fs.mkdirSync(path.join(root, 'prompts'));
    fs.symlinkSync(outside, path.join(root, 'prompts', 'linked'));
    const staged = stageAgentRunCredentials(specWith([{ provider: 'codex', source: root, target: '/home/node/.codex' }]), { environment: brokerEnvironment })!;
    const storeDir = stagedSource(staged.spec, '/home/node/.codex');
    assert.deepEqual(listFiles(storeDir), ['config.toml']);
    assert.deepEqual(staged.bundle.stores[0].skipped.map(entry => entry.reason).sort(), ['symlink', 'symlink']);
    refreshIn(storeDir, 'auth.json', 'attacker');
    await staged.complete();
    assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'host secret');
});

test('transport-neutral API: a runtime without host mounts exchanges file lists', async () => {
    const root = makeStore({ 'auth.json': 'opencode-v1', 'account.json': 'acct', 'storage/x': 'state' });
    const broker = new CredentialBroker({ lock: { lockRoot: path.join(scratch, 'remote-locks') } });
    const bundle = broker.materialize([{ id: 'opencode-data', provider: 'opencode', store: 'data', canonicalRoot: root }]);
    assert.deepEqual(bundle.stores[0].files.map(file => file.path).sort(), ['account.json', 'auth.json']);
    assert.deepEqual(bundle.stores[0].outputs, ['auth.json', 'account.json']);
    const results = await broker.commit(bundle, [
        { storeId: 'opencode-data', path: 'auth.json', content: Buffer.from('opencode-v2'), mtimeMs: Date.now() + 5_000 },
        { storeId: 'opencode-data', path: 'account.json', content: Buffer.from('acct'), mtimeMs: Date.now() },
        // Undeclared outputs are ignored.
        { storeId: 'opencode-data', path: 'storage/x', content: Buffer.from('overwritten'), mtimeMs: Date.now() + 5_000 },
    ]);
    assert.deepEqual(results.map(result => [result.path, result.outcome]).sort(), [['account.json', 'unchanged'], ['auth.json', 'written']]);
    assert.equal(fs.readFileSync(path.join(root, 'auth.json'), 'utf8'), 'opencode-v2');
    assert.equal(fs.readFileSync(path.join(root, 'storage/x'), 'utf8'), 'state');
});

test('every provider manifest declares at least one refreshable or secret credential source', () => {
    for (const manifest of providerCredentialManifests()) {
        assert.ok(refreshableCredentialPaths(manifest).length > 0 || (manifest.secretEnvFiles?.length ?? 0) > 0, `${manifest.provider} ${manifest.store}`);
    }
});

test('runAgent mounts the per-run copy, passes secrets by name and writes the refreshed token back', async () => {
    const root = makeStore({ '.credentials.json': 'claude-v1', 'projects/x/s.jsonl': '{}' });
    const spec = specWith([{ provider: 'claude', source: root, target: '/home/node/.claude' }]);
    calls.length = 0;
    let observedStore = '';
    duringRun = (call) => {
        const volume = call.args[call.args.indexOf('-v', call.args.indexOf('-v') + 1) + 1];
        observedStore = volume.split(':')[0];
        assert.deepEqual(listFiles(observedStore), ['.credentials.json']);
        refreshIn(observedStore, '.credentials.json', 'claude-v2');
    };
    try {
        await runAgent(null, spec, {});
    } finally {
        duringRun = () => {};
    }
    assert.equal(calls.length, 1);
    assert.ok(observedStore.startsWith(runRoot + path.sep));
    assert.ok(!calls[0].args.some(arg => arg.startsWith(`${root}:`)), 'the canonical store is not mounted');
    assert.equal(fs.readFileSync(path.join(root, '.credentials.json'), 'utf8'), 'claude-v2');
    assert.equal(fs.existsSync(observedStore), false);

    const vibeRoot = makeStore({ '.env': 'MISTRAL_API_KEY=mk-run', 'config.toml': '' });
    calls.length = 0;
    await runAgent(null, specWith([{ provider: 'vibe', source: vibeRoot, target: '/home/node/.vibe', readOnly: true }]), {});
    assert.equal(calls[0].options.extraEnvVars?.MISTRAL_API_KEY, 'mk-run');

    process.env[AGENT_CREDENTIAL_BROKER_ENV] = 'legacy';
    try {
        calls.length = 0;
        await runAgent(null, spec, {});
        assert.ok(calls[0].args.includes(`${root}:/home/node/.claude:rw`));
    } finally {
        delete process.env[AGENT_CREDENTIAL_BROKER_ENV];
    }
});

test('OpenCode without a data mount: logins copied under the config tree are staged and refreshed', async () => {
    // Documented fallback: auth copied to <config>/xdg-data/opencode with XDG_DATA_HOME pointing there.
    const root = makeStore({
        'opencode.json': '{}', 'xdg-data/opencode/auth.json': 'oc-v1', 'xdg-data/opencode/account.json': 'acct',
        'xdg-data/opencode/storage/session/x.json': '{}', 'xdg-data/opencode/log/opencode.log': 'log',
    });
    const staged = stageAgentRunCredentials(specWith([{ provider: 'opencode', source: root, target: '/home/node/.config/opencode' }]), { environment: brokerEnvironment })!;
    const storeDir = stagedSource(staged.spec, '/home/node/.config/opencode');
    assert.deepEqual(listFiles(storeDir), ['opencode.json', 'xdg-data/opencode/account.json', 'xdg-data/opencode/auth.json']);
    assert.deepEqual(staged.bundle.stores[0].outputs, ['xdg-data/opencode/auth.json', 'xdg-data/opencode/account.json']);
    refreshIn(storeDir, 'xdg-data/opencode/auth.json', 'oc-v2');
    const results = await staged.complete();
    assert.deepEqual(results.filter(result => result.outcome !== 'unchanged').map(result => [result.path, result.outcome]), [['xdg-data/opencode/auth.json', 'written']]);
    assert.equal(fs.readFileSync(path.join(root, 'xdg-data/opencode/auth.json'), 'utf8'), 'oc-v2');
    assert.equal(fs.readFileSync(path.join(root, 'xdg-data/opencode/account.json'), 'utf8'), 'acct');
});

test('a store the worker cannot write keeps the direct mount so the run persists its refresh', () => {
    if (process.getuid?.() === 0) return; // root bypasses the permission bits that stand in for a read-only mount
    const readOnly = makeStore({ '.credentials.json': 'claude-v1' });
    const writable = makeStore({ 'auth.json': 'codex-v1' });
    fs.chmodSync(readOnly, 0o500);
    try {
        const spec = specWith([
            { provider: 'claude', source: readOnly, target: '/home/node/.claude' },
            { provider: 'codex', source: writable, target: '/home/node/.codex' },
        ]);
        const staged = stageAgentRunCredentials(spec, { environment: brokerEnvironment })!;
        assert.equal(stagedSource(staged.spec, '/home/node/.claude'), readOnly, 'unwritable store keeps its canonical mount');
        assert.notEqual(stagedSource(staged.spec, '/home/node/.codex'), writable);
        assert.ok(renderDockerRunArgs(staged.spec).includes(`${readOnly}:/home/node/.claude:rw`));
        void staged.complete();
        assert.equal(stageAgentRunCredentials(specWith([{ provider: 'claude', source: readOnly, target: '/home/node/.claude' }]), { environment: brokerEnvironment }), undefined);
        // Read-only stores with nothing to refresh are still copied.
        const vibe = makeStore({ 'config.toml': '' });
        fs.chmodSync(vibe, 0o500);
        const vibeRun = stageAgentRunCredentials(specWith([{ provider: 'vibe', source: vibe, target: '/home/node/.vibe', readOnly: true }]), { environment: brokerEnvironment })!;
        assert.notEqual(stagedSource(vibeRun.spec, '/home/node/.vibe'), vibe);
        void vibeRun.complete();
        fs.chmodSync(vibe, 0o700);
    } finally {
        fs.chmodSync(readOnly, 0o700);
    }
});

test('a failed write-back keeps the staged copy with its refreshed token instead of deleting it', async () => {
    const root = makeStore({ 'auth.json': 'codex-v1' });
    const failing = new CredentialBroker({ lock: { lockRoot: path.join(runRoot, '.locks') } });
    failing.commit = async () => { throw new Error('EROFS: read-only file system'); };
    const staged = stageAgentRunCredentials(specWith([{ provider: 'codex', source: root, target: '/home/node/.codex' }]), { environment: brokerEnvironment, broker: failing })!;
    const storeDir = stagedSource(staged.spec, '/home/node/.codex');
    refreshIn(storeDir, 'auth.json', 'codex-v2');
    await staged.complete();
    assert.equal(fs.readFileSync(path.join(storeDir, 'auth.json'), 'utf8'), 'codex-v2', 'the refreshed token survives');
    const marker = JSON.parse(fs.readFileSync(path.join(staged.stagingDir, STAGING_RETAINED_FILE), 'utf8'));
    assert.deepEqual(marker.files, [{ staged: path.join(storeDir, 'auth.json'), canonical: path.join(root, 'auth.json') }]);
    assert.match(marker.error, /EROFS/);
    // Retained copies are never swept, however old.
    sweepStaleStaging(runRoot, Date.now() + 10 * STALE_STAGING_LEASE_MS);
    assert.ok(fs.existsSync(path.join(storeDir, 'auth.json')));
    fs.rmSync(staged.stagingDir, { recursive: true, force: true });

    // Nothing refreshed: a failed write-back loses nothing, so the copy is removed.
    const unchanged = stageAgentRunCredentials(specWith([{ provider: 'codex', source: makeStore({ 'auth.json': 'v1' }), target: '/home/node/.codex' }]), { environment: brokerEnvironment, broker: failing })!;
    await unchanged.complete();
    assert.equal(fs.existsSync(unchanged.stagingDir), false);
});

test('sweeping spares live runs by their lease and reclaims only abandoned copies', async () => {
    const live = stageAgentRunCredentials(specWith([{ provider: 'codex', source: makeStore({ 'auth.json': 'v1' }), target: '/home/node/.codex' }]), { environment: brokerEnvironment })!;
    const lease = path.join(live.stagingDir, STAGING_LEASE_FILE);
    assert.ok(fs.existsSync(lease));
    const ancient = (Date.now() - 2 * STALE_STAGING_LEASE_MS) / 1000;
    // A run older than the cutoff whose lease is still being refreshed survives a sweep.
    fs.utimesSync(live.stagingDir, ancient, ancient);
    sweepStaleStaging(runRoot);
    assert.ok(fs.existsSync(path.join(stagedSource(live.spec, '/home/node/.codex'), 'auth.json')));
    // Once the lease stops being refreshed (owner gone) the copy is reclaimed.
    fs.utimesSync(lease, ancient, ancient);
    sweepStaleStaging(runRoot);
    assert.equal(fs.existsSync(live.stagingDir), false);
    await live.complete();
});

test('a live run refreshes its staging lease while it runs', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    try {
        const { STAGING_LEASE_REFRESH_MS } = await import('../packages/core/src/agents/credentials/hostCredentialStaging.ts');
        const live = stageAgentRunCredentials(specWith([{ provider: 'codex', source: makeStore({ 'auth.json': 'v1' }), target: '/home/node/.codex' }]), { environment: brokerEnvironment })!;
        const lease = path.join(live.stagingDir, STAGING_LEASE_FILE);
        const ancient = (Date.now() - 2 * STALE_STAGING_LEASE_MS) / 1000;
        fs.utimesSync(lease, ancient, ancient);
        fs.utimesSync(live.stagingDir, ancient, ancient);
        mock.timers.tick(STAGING_LEASE_REFRESH_MS);
        sweepStaleStaging(runRoot);
        assert.ok(fs.existsSync(live.stagingDir), 'the heartbeat kept the lease fresh');
        await live.complete();
        assert.equal(fs.existsSync(live.stagingDir), false);
    } finally {
        mock.timers.reset();
    }
});
