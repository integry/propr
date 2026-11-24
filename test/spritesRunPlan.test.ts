import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import { FakeSprite, FakeSpritesClient, parseTar } from './helpers/fakeSprites.ts';
import { cloneSpec, createCredentialStore, ORG_TOKEN, TEST_BUNDLE } from './helpers/spritesHarness.ts';

// The registry also loads the Docker runtime, whose executor opens the database: not needed here.
await mock.module('../packages/core/src/claude/docker/dockerExecutor.js', {
    namedExports: { executeDockerCommand: async () => { throw new Error('the Docker executor is not used by these tests'); } },
});

const {
    buildSpritesPayload, materializeSpritesCredentials, planSpritesRun, renderSpritesArgv, resolveSpritesEnvironment, spritesCliVersionRefusal, spritesMountRefusal,
    SPRITES_RESULT_DIR, SPRITES_ANTIGRAVITY_HOME,
} = await import('../packages/core/src/agents/runtime/sprites/spritesRunPlan.ts');
const { readSpriteCredentialExport, readSpriteExportFile } = await import('../packages/core/src/agents/runtime/sprites/spritesExport.ts');
const { readSpritesCliPins, readSpritesSetupBundle, SPRITES_SETUP_FILES } = await import('../packages/core/src/agents/runtime/sprites/spritesSetup.ts');
const { createTarArchive } = await import('../packages/core/src/agents/runtime/sprites/spritesTar.ts');
const { resolveSpritesRuntimeConfig, spriteNameForSlot, SpritesConfigurationError } = await import('../packages/core/src/agents/runtime/sprites/spritesConfig.ts');
const { SPRITES_RUNTIME_CAPABILITIES, SpritesRuntime } = await import('../packages/core/src/agents/runtime/spritesRuntime.ts');
const { AgentRunSpecBuilder, agentRunNetwork } = await import('../packages/core/src/agents/runtime/agentRunSpec.ts');
const { MAX_RETURNED_CREDENTIAL_BYTES } = await import('../packages/core/src/agents/credentials/broker.ts');

const repoRoot = path.resolve(import.meta.dirname, '..');
const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), 'propr-sprites-plan-'));

test('no provider entrypoint is started as root: the command runs it behind its privilege-dropping shim', () => {
    for (const agent of ['claude', 'codex', 'antigravity'] as const) {
        const argv = renderSpritesArgv(cloneSpec(`${agent}-run`, { agent }));
        assert.deepEqual(argv, ['/bin/bash', '-lc', 'CLONE_WRAPPER', 'SETUP_WRAPPER', `/opt/propr/entrypoints/${agent}-as-agent`, agent, '-p', '-']);
        assert.ok(!argv.some(argument => argument.startsWith('/home/node/')), 'nothing root executes lives where the agent user can write');
    }
    const foreign = cloneSpec('foreign');
    foreign.repoSetup!.providerEntrypoint = '/home/node/workspace/evil-entrypoint.sh';
    assert.throws(() => renderSpritesArgv(foreign), /will not start \/home\/node\/workspace\/evil-entrypoint\.sh as root/);
    const direct = cloneSpec('direct');
    delete direct.repoSetup;
    direct.entrypoint = '/home/node/claude-entrypoint.sh';
    assert.deepEqual(renderSpritesArgv(direct).slice(0, 5), ['/bin/bash', '-lc', 'CLONE_WRAPPER', 'propr-workspace-transport:run-as-agent', '/opt/propr/entrypoints/claude-entrypoint.sh']);
});

test('only clone-mode Claude, Codex and Antigravity runs are accepted', () => {
    const bind = cloneSpec('bind');
    bind.workspace = { ...bind.workspace, mode: 'bind' };
    assert.throws(() => renderSpritesArgv(bind), /only the clone workspace transport/);
    const vibe = cloneSpec('vibe');
    vibe.profile.agentType = 'vibe';
    assert.throws(() => renderSpritesArgv(vibe), /does not run vibe agents; supported: claude, codex, antigravity/);
    assert.deepEqual([...SPRITES_RUNTIME_CAPABILITIES.workspaceTransports!], ['clone']);
    assert.equal(SPRITES_RUNTIME_CAPABILITIES.supportsBindMounts, false);
    assert.equal(SPRITES_RUNTIME_CAPABILITIES.supportsRestrictedNetwork, false);
    assert.equal(SPRITES_RUNTIME_CAPABILITIES.reattach, false);
});

test('mounts become copies or empty directories, or the run is refused', () => {
    const root = temporary();
    const seed = path.join(root, 'claude.json');
    fs.writeFileSync(seed, '{"seed":true}');
    const mount = (overrides: Record<string, unknown>) => ({ type: 'bind', source: seed, target: '/run/propr-claude/claude.json', readOnly: true, purpose: 'credential', order: 0, ...overrides }) as never;
    assert.equal(spritesMountRefusal(mount({})), undefined);
    assert.equal(spritesMountRefusal(mount({ source: '/tmp/claude-logs', target: '/tmp/claude-logs', readOnly: false, purpose: 'logs' })), undefined);
    assert.equal(spritesMountRefusal(mount({ source: root, target: '/home/node/.claude', readOnly: false, credentialStore: { provider: 'claude', store: 'config', perRun: true } })), undefined);
    assert.match(spritesMountRefusal(mount({ source: root, target: '/home/node/.claude', readOnly: false, credentialStore: { provider: 'claude', store: 'config', perRun: false } }))!, /cannot keep the claude config store .* between runs/);
    assert.match(spritesMountRefusal(mount({ source: root, target: '/home/node/data', readOnly: false, purpose: 'data' }))!, /cannot share the host directory/);
    assert.match(spritesMountRefusal(mount({ source: root, target: '/home/node/skills' }))!, /only copy read-only regular files/);
    assert.match(spritesMountRefusal(mount({ source: '/tmp/git-processor', target: '/tmp/git-processor', purpose: 'git' }))!, /use the clone workspace transport/);
    for (const target of ['/etc/passwd', '/opt/propr/run/in', '/home/node/../../etc/x', 'relative', '/home/node']) {
        assert.match(spritesMountRefusal(mount({ target }))!, /Sprite targets must be under/, target);
    }
    // The registry asks the runtime instead of refusing every bind.
    assert.equal(new SpritesRuntime({ environment: {} }).unsupportedMount(mount({})), undefined);

    const spec = cloneSpec('with-seed', { customize: builder => builder.strictBind(seed, '/run/propr-claude/claude.json', true, 'credential') });
    const plan = planSpritesRun(spec, {}, ORG_TOKEN);
    assert.deepEqual(plan.files, [{ source: seed, target: '/run/propr-claude/claude.json' }]);
    assert.deepEqual(plan.directories, ['/tmp/claude-logs', '/home/node/.cache-scratch']);
    const entries = parseTar(buildSpritesPayload(plan, { stdin: true, stdinData: 'the prompt' }));
    const file = (name: string) => entries.find(entry => entry.path === name)!.content.toString('utf8');
    assert.equal(file('files/0'), '{"seed":true}');
    assert.equal(file('stdin'), 'the prompt');
    assert.deepEqual(file('manifest').split('\0').slice(0, -1), ['file', 'files/0', '/run/propr-claude/claude.json', 'dir', '/tmp/claude-logs', 'dir', '/home/node/.cache-scratch']);
    assert.ok(entries.every(entry => entry.type === 'dir' || (entry.mode & 0o077) === 0), 'payload files are private');
});

test('the run environment follows Docker precedence, points the result at the root-owned directory and carries no org token', () => {
    const root = temporary();
    const envFile = path.join(root, 'run.env');
    fs.writeFileSync(envFile, `FROM_FILE=file\nOVERRIDDEN=file\nINHERITED\nLEAK=${ORG_TOKEN}\n`);
    const spec = cloneSpec('env', {
        customize: builder => builder.envFile(envFile).env('OVERRIDDEN', 'spec').env('BY_NAME').env('UNSET_BY_NAME').env('PROPR_ANTIGRAVITY_TRANSCRIPT_PATH', '/tmp/git-processor/t.jsonl'),
    });
    const { environment, withheld } = resolveSpritesEnvironment(spec, { INHERITED: 'from-worker', BY_NAME: 'named', PROPR_SPRITES_TOKEN: ORG_TOKEN }, ORG_TOKEN);
    assert.equal(environment.get('FROM_FILE'), 'file');
    assert.equal(environment.get('OVERRIDDEN'), 'spec');
    assert.equal(environment.get('INHERITED'), 'from-worker');
    assert.equal(environment.get('BY_NAME'), 'named');
    assert.ok(!environment.has('UNSET_BY_NAME'));
    assert.equal(environment.get('PROPR_AGENT_TYPE'), 'claude');
    assert.equal(environment.get('PROPR_WORKSPACE_CLONE_RESULT_DIR'), SPRITES_RESULT_DIR);
    assert.ok(!environment.has('PROPR_ANTIGRAVITY_TRANSCRIPT_PATH'));
    assert.deepEqual(withheld, ['LEAK']);
    // Everything that runs as root resolves commands through root-owned directories only.
    assert.equal(environment.get('PATH'), '/opt/propr/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');
    assert.equal(environment.get('HOME'), '/root');
    assert.ok(![...environment.values()].some(value => value.includes(ORG_TOKEN)));
    const invalid = cloneSpec('bad-env', { customize: builder => builder.env('BAD NAME', 'x') });
    assert.throws(() => resolveSpritesEnvironment(invalid, {}, ORG_TOKEN), /invalid environment variable name/);
});

test('credentials are materialised by the broker and uploaded in the one payload archive', () => {
    const root = temporary();
    const store = createCredentialStore(root, 'claude');
    fs.writeFileSync(path.join(store.directory, 'settings.json'), '{}');
    fs.mkdirSync(path.join(store.directory, 'skills', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(store.directory, 'skills', 'deep', 'SKILL.md'), 'skill');
    fs.mkdirSync(path.join(store.directory, 'projects'));
    fs.writeFileSync(path.join(store.directory, 'projects', 'session.jsonl'), 'a previous session: not part of the manifest');
    fs.symlinkSync('/etc/passwd', path.join(store.directory, 'CLAUDE.md'));
    const plan = planSpritesRun(cloneSpec('creds', { credentialStore: store.directory }), {}, ORG_TOKEN);
    const credentials = materializeSpritesCredentials(plan, { environment: { HOME: root }, orgToken: ORG_TOKEN })!;
    assert.deepEqual(credentials.outputs, [{ storeId: 'claude-config', path: '.credentials.json', livePath: '/home/node/.claude/.credentials.json' }]);
    const entries = parseTar(buildSpritesPayload(plan, { credentials, stdin: false }));
    const paths = entries.map(entry => entry.path);
    assert.deepEqual(paths.filter(entry => entry.startsWith('store/0/')).sort(), ['store/0/.credentials.json', 'store/0/settings.json', 'store/0/skills', 'store/0/skills/deep', 'store/0/skills/deep/SKILL.md']);
    assert.ok(!paths.includes('stdin'));
    const manifest = entries.find(entry => entry.path === 'manifest')!.content.toString('utf8').split('\0').slice(0, -1);
    assert.deepEqual(manifest.slice(0, 3), ['store', 'store/0', '/home/node/.claude']);
    assert.deepEqual(manifest.slice(-3), ['output', '0', '/home/node/.claude/.credentials.json']);

    // An API-key run gets no stored login, and nothing to export.
    const keyed = planSpritesRun(cloneSpec('keyed', { credentialStore: store.directory, customize: builder => builder.env('ANTHROPIC_API_KEY', 'sk-test') }), {}, ORG_TOKEN);
    const keyedCredentials = materializeSpritesCredentials(keyed, { environment: { HOME: root }, orgToken: ORG_TOKEN })!;
    assert.deepEqual(keyedCredentials.outputs, []);
    assert.ok(!parseTar(buildSpritesPayload(keyed, { credentials: keyedCredentials, stdin: false })).some(entry => entry.path.endsWith('.credentials.json')));
});

test('the payload archive unpacks with GNU tar, long names, modes and times included', () => {
    const root = temporary();
    const long = `store/0/${'d'.repeat(70)}/${'é'.repeat(30)}/token.json`;
    fs.writeFileSync(path.join(root, 'payload.tar'), createTarArchive([
        { path: 'argv', type: 'file', content: Buffer.from('a\0b\0'), mode: 0o600 },
        { path: 'store', type: 'directory', mode: 0o700 },
        { path: 'store/0', type: 'directory', mode: 0o700 },
        { path: 'store/0/.credentials.json', type: 'file', content: Buffer.from('{"t":1}'), mode: 0o640, mtimeMs: 1_700_000_000_123 },
        { path: long, type: 'file', content: Buffer.alloc(1025, 7), mode: 0o600, mtimeMs: 1_600_000_000_000 },
    ]));
    fs.mkdirSync(path.join(root, 'in'));
    execFileSync('tar', ['-xf', path.join(root, 'payload.tar'), '-C', path.join(root, 'in'), '--no-same-owner']);
    assert.equal(fs.readFileSync(path.join(root, 'in', 'argv'), 'utf8'), 'a\0b\0');
    const token = fs.statSync(path.join(root, 'in', 'store/0/.credentials.json'));
    assert.equal(token.mode & 0o777, 0o640);
    assert.equal(Math.floor(token.mtimeMs / 1000), 1_700_000_000);
    assert.equal(fs.readFileSync(path.join(root, 'in', long)).length, 1025);
    for (const invalid of ['/absolute', '../escape', 'a/../b', 'a//b', '']) {
        assert.throws(() => createTarArchive([{ path: invalid, type: 'file', mode: 0o600 }]), /Invalid payload path/, invalid);
    }
});

test('the export reader takes plain regular files within the limit and nothing else', async () => {
    const sprite = new FakeSprite('reader', 'sprite-x', new FakeSpritesClient());
    const filesystem = sprite.filesystem();
    const out = '/opt/propr/run/out';
    sprite.putFile(`${out}/0`, 'refreshed-token', 1_700_000_000_000);
    sprite.putFile(`${out}/0.mtime`, '1700000000\n');
    assert.deepEqual(await readSpriteCredentialExport(filesystem, out, 0), { content: Buffer.from('refreshed-token'), mtimeMs: 1_700_000_000_000 });

    sprite.putFile('/root/secret', 'root-only secret');
    sprite.put(`${out}/1`, { type: 'symlink', target: '/root/secret' });
    assert.equal(await readSpriteCredentialExport(filesystem, out, 1), 'symlink');
    assert.equal((await filesystem.readFile(`${out}/1`)).toString(), 'root-only secret', 'the fake follows links on read, as a server would: the reader must not ask');
    sprite.put(`${out}/2`, { type: 'fifo' });
    assert.equal(await readSpriteCredentialExport(filesystem, out, 2), 'not-regular');
    sprite.put(`${out}/3`, { type: 'dir' });
    assert.equal(await readSpriteCredentialExport(filesystem, out, 3), 'not-regular');
    sprite.putFile(`${out}/4`, Buffer.alloc(MAX_RETURNED_CREDENTIAL_BYTES + 1));
    assert.equal(await readSpriteCredentialExport(filesystem, out, 4), 'oversize');
    sprite.putFile(`${out}/5`, Buffer.alloc(MAX_RETURNED_CREDENTIAL_BYTES));
    assert.equal(typeof await readSpriteCredentialExport(filesystem, out, 5), 'object', 'exactly the limit is accepted');
    assert.equal(await readSpriteCredentialExport(filesystem, out, 6), 'missing');

    // A size reported smaller than the content does not get an oversize file through.
    const lying = { ...filesystem, stat: async (file: string) => ({ ...(await filesystem.stat(file)), size: 1 }) };
    assert.deepEqual(await readSpriteExportFile(lying, out, '4', MAX_RETURNED_CREDENTIAL_BYTES), { ok: false, reason: 'oversize' });
    // A modification time from the future (or garbage) cannot outrank a later write-back decision.
    sprite.putFile(`${out}/7`, 'token');
    sprite.putFile(`${out}/7.mtime`, '99999999999\n');
    assert.equal((await readSpriteCredentialExport(filesystem, out, 7, 5000) as { mtimeMs: number }).mtimeMs, 5000);
    sprite.put(`${out}/7.mtime`, { type: 'symlink', target: '/root/secret' });
    assert.equal((await readSpriteCredentialExport(filesystem, out, 7, 5000) as { mtimeMs: number }).mtimeMs, 5000);
    // The reader never leaves the directory it was given.
    for (const name of ['../in/env', 'a/b', '..', '']) await assert.rejects(readSpriteExportFile(filesystem, out, name, 10), /Invalid export file name/);
});

test('CLI pins come from Dockerfile.agent, Antigravity release and digest included, and feed the setup revision', () => {
    const pins = readSpritesCliPins(repoRoot);
    const dockerfile = fs.readFileSync(path.join(repoRoot, 'Dockerfile.agent'), 'utf8');
    for (const name of ['CLAUDE_CLI_VERSION', 'CODEX_CLI_VERSION', 'ANTIGRAVITY_CLI_VERSION', 'ANTIGRAVITY_CLI_RELEASE_ID', 'ANTIGRAVITY_CLI_SHA512'] as const) {
        assert.ok(dockerfile.includes(`ARG ${name}=${pins[name]}\n`), name);
    }
    assert.match(pins.ANTIGRAVITY_CLI_SHA512, /^[0-9a-f]{128}$/);
    const bundle = readSpritesSetupBundle(repoRoot);
    assert.deepEqual(bundle.files.map(file => file.name), [...SPRITES_SETUP_FILES]);
    assert.match(bundle.hash, /^[0-9a-f]{16}$/);

    const root = temporary();
    fs.mkdirSync(path.join(root, 'scripts'));
    for (const file of SPRITES_SETUP_FILES) fs.copyFileSync(path.join(repoRoot, 'scripts', file), path.join(root, 'scripts', file));
    fs.writeFileSync(path.join(root, 'Dockerfile.agent'), dockerfile.replace(`ARG CLAUDE_CLI_VERSION=${pins.CLAUDE_CLI_VERSION}`, 'ARG CLAUDE_CLI_VERSION=9.9.9'));
    assert.equal(readSpritesCliPins(root).CLAUDE_CLI_VERSION, '9.9.9');
    assert.notEqual(readSpritesSetupBundle(root).hash, bundle.hash, 'a changed pin is a new setup revision');
    fs.writeFileSync(path.join(root, 'Dockerfile.agent'), dockerfile.replace(/^ARG ANTIGRAVITY_CLI_SHA512=.*$/gm, ''));
    assert.throws(() => readSpritesCliPins(root), /does not pin ANTIGRAVITY_CLI_SHA512/);
    assert.throws(() => readSpritesCliPins(path.join(root, 'missing')), /reads its CLI pins from/);
});

test('an agent that selects another CLI version is refused, not run on the pinned one', () => {
    const { pins } = TEST_BUNDLE;
    assert.equal(spritesCliVersionRefusal({ type: 'claude' }, pins), undefined);
    assert.equal(spritesCliVersionRefusal({ type: 'claude', cliVersionType: 'default' }, pins), undefined);
    assert.equal(spritesCliVersionRefusal({ type: 'codex', cliVersionType: 'specific', cliVersion: '0.171.0' }, pins), undefined);
    assert.equal(spritesCliVersionRefusal({ type: 'antigravity', cliVersionType: 'tag', cliVersion: 'latest', cliVersionResolved: '1.5.15' }, pins), undefined);
    assert.match(spritesCliVersionRefusal({ type: 'claude', alias: 'c1', cliVersionType: 'specific', cliVersion: '2.0.0' }, pins)!, /agent 'c1' selects claude CLI 2\.0\.0, but a Sprite runs only claude CLI 2\.1\.330/);
    assert.match(spritesCliVersionRefusal({ type: 'codex', cliVersionType: 'tag', cliVersion: 'latest' }, pins)!, /selects codex CLI tag latest/);
    const runtime = new SpritesRuntime({ environment: {}, setupBundle: () => TEST_BUNDLE });
    assert.equal(runtime.unsupportedAgentConfig(null, cloneSpec('default')), undefined);
    assert.match(runtime.unsupportedAgentConfig({ runtime: 'sprites', cliVersionType: 'specific', cliVersion: '1.0.0' }, cloneSpec('other'))!, /claude CLI 1\.0\.0/);
});

test('configuration: the token is required, names are validated', () => {
    assert.throws(() => resolveSpritesRuntimeConfig({}), error => error instanceof SpritesConfigurationError && /PROPR_SPRITES_TOKEN/.test(error.message));
    const config = resolveSpritesRuntimeConfig({ SPRITES_TOKEN: ' fallback ', PROPR_SPRITES_WORKER_ID: 'W-1', PROPR_SPRITES_MAX_SPRITES: '2', PROPR_SPRITES_REGION: 'ord', HOME: '/home/op' });
    assert.equal(config.token, 'fallback');
    assert.equal(config.maxSprites, 2);
    assert.equal(config.stateDir, '/home/op/.propr/agent-credentials/.propr-sprites');
    assert.equal(spriteNameForSlot(config, 1), 'propr-w-1-1');
    assert.equal(resolveSpritesRuntimeConfig({ PROPR_SPRITES_TOKEN: 't', PROPR_SPRITES_STATE_DIR: '/var/lib/propr/sprites' }).stateDir, '/var/lib/propr/sprites');
    assert.throws(() => resolveSpritesRuntimeConfig({ PROPR_SPRITES_TOKEN: 't', PROPR_SPRITES_MAX_SPRITES: '0' }), /positive integer/);
    assert.throws(() => resolveSpritesRuntimeConfig({ PROPR_SPRITES_TOKEN: 't', PROPR_SPRITES_NAME_PREFIX: 'Bad_Prefix' }), /PROPR_SPRITES_NAME_PREFIX/);
});

/** Runs bash with the launcher or setup script sourced (only its functions are defined) and returns stdout. */
function bash(script: string, source: string, env: Record<string, string> = {}): { stdout: string; status: number | null; stderr: string } {
    const result = spawnSync('bash', ['-c', `source "${path.join(repoRoot, 'scripts', source)}"\n${script}`], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } });
    return { stdout: result.stdout, status: result.status, stderr: result.stderr };
}

test('launcher export: a symlink or special file at a credential path exports nothing, an oversize file is cut for the worker to refuse', () => {
    const root = temporary();
    const out = path.join(root, 'out');
    fs.mkdirSync(out);
    const secret = path.join(root, 'root-owned-secret');
    fs.writeFileSync(secret, 'must never be exported');
    const token = path.join(root, 'token');
    fs.writeFileSync(token, 'refreshed');
    fs.utimesSync(token, 1_700_000_000, 1_700_000_000);
    const link = path.join(root, 'planted-link');
    fs.symlinkSync(secret, link);
    const fifo = path.join(root, 'fifo');
    execFileSync('mkfifo', [fifo]);
    const big = path.join(root, 'big');
    fs.writeFileSync(big, Buffer.alloc(1024 * 1024 + 4096, 0x61));
    // The privilege drop is replaced by a recorder: the reads themselves run unchanged.
    const result = bash(`
        as_agent() { echo "as_agent $1" >> "${root}/drops"; "$@" </dev/null; }
        export_output 0 "${token}" "${out}"
        export_output 1 "${link}" "${out}"
        export_output 2 "${fifo}" "${out}"
        export_output 3 "${root}/missing" "${out}"
        export_output 4 "${big}" "${out}"
        export_output 5 "${root}" "${out}"
    `, 'sprites-launcher.sh');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readdirSync(out).sort(), ['0', '0.mtime', '4', '4.mtime']);
    assert.equal(fs.readFileSync(path.join(out, '0'), 'utf8'), 'refreshed');
    assert.equal(fs.readFileSync(path.join(out, '0.mtime'), 'utf8'), '1700000000\n');
    assert.equal(fs.statSync(path.join(out, '4')).size, 1024 * 1024 + 1, 'one byte over the worker limit, so the worker sees it as oversize');
    assert.equal(fs.readFileSync(secret, 'utf8'), 'must never be exported');
    // Every read of an agent-controlled path went through the privilege drop.
    assert.ok(fs.readFileSync(path.join(root, 'drops'), 'utf8').trim().split('\n').length >= 7);
});

test('launcher: root never touches an agent-controlled path after the command starts', () => {
    const script = fs.readFileSync(path.join(repoRoot, 'scripts', 'sprites-launcher.sh'), 'utf8');
    const started = script.indexOf('setsid env -i');
    assert.ok(started > 0);
    const afterStart = script.slice(started, script.indexOf('follow_output() {'));
    // After the command started, the launcher only waits, kills, exports through as_agent and writes inside its own run directory.
    for (const line of afterStart.split('\n').map(text => text.trim()).filter(text => text && !text.startsWith('#'))) {
        assert.ok(!/\b(cp|mv|install|chmod|rm|ln|cat|tar)\b/.test(line), `no root file operation after the command starts: ${line}`);
        if (/\bchown\b/.test(line)) assert.match(line, /chown -R "\$owner" out result/, line);
    }
    // The export reads as the agent user only.
    const exportFunction = script.slice(script.indexOf('export_output() {'), script.indexOf('run_launcher() {'));
    for (const line of exportFunction.split('\n').filter(text => /\$live/.test(text) && !text.trim().startsWith('#') && !/^\s*local /.test(text))) {
        assert.match(line, /as_agent /, `agent-controlled path read without dropping privileges: ${line}`);
    }
    assert.match(script, /as_agent\(\) \{\n\s+su-exec "\$AGENT_USER" env -i /);
    // It refuses a Sprite that is not at its clean checkpoint instead of cleaning it.
    assert.match(script, /the run directory already holds a run: the Sprite is not at its clean checkpoint/);
    assert.match(script, /processes of the \$AGENT_USER user are already running: the Sprite is not at its clean checkpoint/);
    assert.equal(spawnSync('bash', ['-n', path.join(repoRoot, 'scripts', 'sprites-launcher.sh')]).status, 0);
    assert.equal(spawnSync('bash', [path.join(repoRoot, 'scripts', 'sprites-launcher.sh'), 'bogus']).status, 2);
    // Not root here: the launcher refuses to run.
    if (process.getuid?.() !== 0) assert.equal(spawnSync('bash', [path.join(repoRoot, 'scripts', 'sprites-launcher.sh'), 'run']).status, 125);
});

test('launcher: the agent user\'s processes are found by any of their UIDs', () => {
    const uid = String(process.getuid?.() ?? 0);
    const mine = bash(`agent_pids "${uid}" | grep -c .`, 'sprites-launcher.sh');
    assert.ok(Number(mine.stdout.trim()) >= 1, 'this user\'s processes are listed');
    assert.equal(bash('agent_pids 4123456789 | wc -l', 'sprites-launcher.sh').stdout.trim(), '0');
    assert.equal(bash('kill_agent_processes 4123456789; echo $?', 'sprites-launcher.sh').stdout.trim(), '0');
});

test('setup: the provider entrypoints run entirely as the agent user, Antigravity with its disposable HOME and no root sync-back', () => {
    const root = temporary();
    const source = path.join(root, 'source');
    const entries = path.join(root, 'entrypoints');
    fs.mkdirSync(source);
    for (const agent of ['claude', 'codex', 'antigravity']) {
        // Stand-ins that report who they run as and what they were asked to exec.
        fs.writeFileSync(path.join(source, `${agent}-entrypoint.sh`), '#!/bin/bash\necho "entrypoint uid-check=$FAKE_DROPPED home=$HOME user=$USER path=$PATH args=$*"\n');
    }
    const fakeBin = path.join(root, 'bin');
    fs.mkdirSync(fakeBin);
    // su-exec stand-in: records the drop and marks the environment, then runs the command.
    fs.writeFileSync(path.join(fakeBin, 'su-exec'), '#!/bin/bash\necho "su-exec $1" >&2\nshift\nFAKE_DROPPED=yes exec "$@"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(fakeBin, 'id'), '#!/bin/bash\nif [ "$1" = "-u" ]; then echo 0; else /usr/bin/id "$@"; fi\n', { mode: 0o755 });
    const installed = bash(`install_entrypoints "${source}" "${entries}" /opt/propr/bin ${SPRITES_ANTIGRAVITY_HOME}`, 'sprites-agent-setup.sh');
    assert.equal(installed.status, 0, installed.stderr);
    assert.deepEqual(fs.readdirSync(entries).sort(), ['antigravity-as-agent', 'antigravity-entrypoint.sh', 'claude-as-agent', 'claude-entrypoint.sh', 'codex-as-agent', 'codex-entrypoint.sh']);
    const run = (agent: string, env: Record<string, string> = {}) => spawnSync(path.join(entries, `${agent}-as-agent`), [agent, '-p', '-'], {
        encoding: 'utf8', env: { PATH: `${fakeBin}:${process.env.PATH}`, HOME: '/root', USER: 'root', PROPR_WORKSPACE: root, ...env },
    });
    const claude = run('claude');
    assert.equal(claude.status, 0, claude.stderr);
    assert.match(claude.stderr, /^su-exec node$/m, 'root is given up before the entrypoint starts');
    assert.match(claude.stdout, /uid-check=yes home=\/home\/node user=node path=\/opt\/propr\/bin:\/home\/node\/\.local\/bin:\/usr\/local\/sbin:.* args=claude -p -/);
    const antigravity = run('antigravity', { PROPR_EPHEMERAL_STATE: '1' });
    // The disposable HOME is on the Sprite's checkpointed root, never under /tmp (a checkpoint restore does not reset /tmp).
    assert.equal(SPRITES_ANTIGRAVITY_HOME, '/var/lib/propr/run/antigravity-home');
    assert.match(antigravity.stdout, /uid-check=yes home=\/home\/node .* args=env HOME=\/var\/lib\/propr\/run\/antigravity-home antigravity -p -/);
    assert.doesNotMatch(antigravity.stdout, /\/tmp\//);
    assert.doesNotMatch(run('antigravity').stdout, /antigravity-home/);

    // The real entrypoint, unprivileged as on a Sprite, prepares the disposable HOME where the shim names it.
    const home = path.join(root, 'checkpointed', 'antigravity-home');
    const agySource = path.join(root, 'gemini-source');
    fs.mkdirSync(path.join(agySource, 'antigravity-cli'), { recursive: true });
    fs.writeFileSync(path.join(agySource, 'antigravity-cli', 'antigravity-oauth-token'), 'oauth');
    // Its first part only (where the HOME is chosen and filled): the rest sets up /home/node itself.
    const entrypointText = fs.readFileSync(path.join(repoRoot, 'scripts', 'antigravity-entrypoint.sh'), 'utf8');
    const preparation = entrypointText.slice(0, entrypointText.indexOf('prepare_antigravity_config_dir() {'));
    assert.match(preparation, /Using disposable Antigravity runtime state/);
    const entry = (env: Record<string, string>) => spawnSync('bash', ['-c', `${preparation}\necho "home=$antigravity_runtime_home"`], {
        encoding: 'utf8', env: { PATH: process.env.PATH ?? '', PROPR_EPHEMERAL_STATE: '1', PROPR_ANTIGRAVITY_SOURCE_CONFIG: agySource, ...env },
    });
    if (process.getuid?.() !== 0) {
        const prepared = entry({ PROPR_ANTIGRAVITY_RUNTIME_HOME: home });
        assert.equal(prepared.status, 0, prepared.stderr);
        assert.match(prepared.stdout, new RegExp(`^home=${home}$`, 'm'));
        assert.equal(fs.readFileSync(path.join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), 'utf8'), 'oauth');
    }
    // Only an absolute path given to an unprivileged entrypoint is taken: as root (the image) the script chowns that directory.
    assert.match(preparation, /case "\$\{PROPR_ANTIGRAVITY_RUNTIME_HOME:-\}" in\n\s+\/\*\) if \[ "\$\(id -u\)" != "0" \]; then antigravity_runtime_home=/);
    const asRoot = spawnSync('bash', ['-c', `id() { echo 0; }; chown() { :; }; mkdir() { :; }; cp() { :; }\n${preparation}\necho "home=$antigravity_runtime_home"`], {
        encoding: 'utf8', env: { PATH: process.env.PATH ?? '', PROPR_EPHEMERAL_STATE: '1', PROPR_ANTIGRAVITY_RUNTIME_HOME: home },
    });
    assert.match(asRoot.stdout, /^home=\/tmp\/propr-antigravity-home$/m, 'the image, started as root, keeps its own place');

    // The real Antigravity entrypoint syncs state back to its source only as root: started as the agent user it never does.
    const entrypoint = fs.readFileSync(path.join(repoRoot, 'scripts', 'antigravity-entrypoint.sh'), 'utf8');
    const syncBack = entrypoint.indexOf('propr-tmp-$$');
    assert.ok(syncBack > 0);
    const guard = entrypoint.lastIndexOf('if [ "$(id -u)" = "0" ] && [ "$antigravity_ephemeral" = "1" ]; then', syncBack);
    const unprivileged = entrypoint.indexOf('    else\n        exec "$@"', syncBack);
    assert.ok(guard > 0 && unprivileged > syncBack, 'the sync-back is inside the root-only branch');

    const setup = fs.readFileSync(path.join(repoRoot, 'scripts', 'sprites-agent-setup.sh'), 'utf8');
    // Verified live on Sprites: node on root's PATH, npm 12 install scripts, the node user without sudo.
    assert.match(setup, /link_sprite_node \/\.sprite\/bin\/node \/usr\/local\/bin/);
    assert.match(setup, /for bin in node npm npx; do/);
    assert.match(setup, /npm install -g .*--allow-scripts="\$package"/);
    assert.match(setup, /the node user must not have sudo/);
    // The run's scratch directory is on the checkpointed root, and the shim is told where Antigravity's HOME goes.
    assert.match(setup, /^scratch_dir="\$state_dir\/run"$/m);
    assert.match(setup, /^state_dir=\/var\/lib\/propr$/m);
    assert.match(setup, /install -d -m 1777 -o root -g root "\$scratch_dir"/);
    assert.match(setup, /^antigravity_home="\$scratch_dir\/antigravity-home"$/m);
    assert.match(setup, /sha512sum -c -/);
    assert.equal(spawnSync('bash', ['-n', path.join(repoRoot, 'scripts', 'sprites-agent-setup.sh')]).status, 0);
});

test('setup: sudo rights are read from sudo\'s listing, not its exit status', () => {
    const root = temporary();
    const fakeBin = path.join(root, 'bin');
    fs.mkdirSync(fakeBin);
    // The Sprite's sudo: `sudo -l -U <user>` exits 0 whether or not the user may run anything.
    fs.writeFileSync(path.join(fakeBin, 'sudo'), `#!/bin/bash
user="\${@: -1}"
case "$user" in
    allowed) printf 'Matching Defaults entries for allowed on sprite:\\n    env_reset\\n\\nUser allowed may run the following commands on sprite:\\n    (ALL : ALL) ALL\\n' ;;
    *) echo "User $user is not allowed to run sudo on sprite." ;;
esac
exit 0
`, { mode: 0o755 });
    const check = (user: string) => spawnSync('/bin/bash', ['-c', `source "${path.join(repoRoot, 'scripts', 'sprites-agent-setup.sh')}"\nuser_may_sudo ${user}`], {
        encoding: 'utf8', env: { PATH: `${fakeBin}:${process.env.PATH}` },
    }).status;
    assert.equal(check('node'), 1, 'a user sudo lists nothing for has no sudo, although sudo exited 0');
    assert.equal(check('nobody'), 1);
    assert.equal(check('allowed'), 0);
    const setup = fs.readFileSync(path.join(repoRoot, 'scripts', 'sprites-agent-setup.sh'), 'utf8');
    assert.match(setup, /if user_may_sudo node; then die /);
    assert.doesNotMatch(setup, /if sudo -l[^\n]*>\/dev\/null 2>&1; then/, 'the exit status of sudo -l is never the check');
});

test('setup: node, npm and npx are linked from the nvm shim\'s real directory when sudo\'s PATH has no node', () => {
    const root = temporary();
    const real = path.join(root, 'nvm', 'versions', 'node', 'v22', 'bin');
    const target = path.join(root, 'usr-local-bin');
    fs.mkdirSync(real, { recursive: true });
    fs.mkdirSync(target);
    for (const bin of ['node', 'npm', 'npx']) fs.writeFileSync(path.join(real, bin), '#!/bin/sh\necho real\n', { mode: 0o755 });
    const shim = path.join(root, 'shim-node');
    fs.writeFileSync(shim, `#!/bin/sh\necho "${real}/node"\n`, { mode: 0o755 });
    // A PATH without node, as sudo's secure_path is on a Sprite.
    const empty = path.join(root, 'empty-bin');
    fs.mkdirSync(empty);
    for (const tool of ['dirname', 'ln']) fs.symlinkSync(execFileSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim(), path.join(empty, tool));
    const linked = spawnSync('/bin/bash', ['-c', `source "${path.join(repoRoot, 'scripts', 'sprites-agent-setup.sh')}"\nlink_sprite_node "${shim}" "${target}"`], { encoding: 'utf8', env: { PATH: empty } });
    assert.equal(linked.status, 0, linked.stderr);
    for (const bin of ['node', 'npm', 'npx']) assert.equal(fs.readlinkSync(path.join(target, bin)), path.join(real, bin));
});

test('the registry runs a Sprites spec through the runtime\'s own mount and version checks', async () => {
    const { assertAgentRuntimeSupports, AgentRuntimeCapabilityError, getAgentRuntime, registerAgentRuntime, runAgent } = await import('../packages/core/src/agents/runtime/registry.ts');
    assert.equal(getAgentRuntime({ runtime: 'sprites' }, {}).kind, 'sprites');
    const runtime = new SpritesRuntime({ environment: {}, setupBundle: () => TEST_BUNDLE });
    registerAgentRuntime('sprites-test', () => runtime as never);
    const root = temporary();
    const store = createCredentialStore(root, 'claude');
    assert.doesNotThrow(() => assertAgentRuntimeSupports(runtime as never, cloneSpec('ok', { credentialStore: store.directory })));
    const goal = cloneSpec('goal', { customize: builder => builder.credentialBind(store.directory, '/home/node/.claude', false, { provider: 'claude', store: 'config', perRun: false }) });
    assert.throws(() => assertAgentRuntimeSupports(runtime as never, goal), error => error instanceof AgentRuntimeCapabilityError && error.capability === 'bind_mounts' && /between runs/.test(error.message));
    const bound = new AgentRunSpecBuilder({
        agentType: 'claude', image: 'i', name: 'bound', stdin: true, user: '0:0', network: agentRunNetwork('bridge'),
        workspace: { hostPath: '/tmp/w', containerPath: '/home/node/workspace', readOnly: false },
    }).workspaceMount().command('claude').build();
    assert.throws(() => assertAgentRuntimeSupports(runtime as never, bound), /use the clone workspace transport/);
    await assert.rejects(
        runAgent({ runtime: 'sprites-test', type: 'claude', alias: 'pinned', cliVersionType: 'specific', cliVersion: '1.2.3' }, cloneSpec('versioned'), {}),
        error => error instanceof AgentRuntimeCapabilityError && error.capability === 'agent_config' && /claude CLI 1\.2\.3/.test(error.message),
    );
});
