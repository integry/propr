import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { closeConnection } from '../packages/core/src/db/connection.ts';
import { agentRunNetwork } from '../packages/core/src/agents/runtime/agentRunSpec.ts';
import type { AgentRunSpec } from '../packages/core/src/agents/runtime/types.ts';
import { FlyMachinesRuntime } from '../packages/core/src/agents/runtime/flyMachinesRuntime.ts';
import { SpritesRuntime } from '../packages/core/src/agents/runtime/spritesRuntime.ts';
import { prepareLaunch } from '../packages/core/src/agents/runtime/fly/launch.ts';
import { flyConfig } from '../packages/core/src/agents/runtime/fly/config.ts';
import type { MachineLaunch, MachinesApi } from '../packages/core/src/agents/runtime/fly/api.ts';
import { RUN } from '../packages/core/src/agents/runtime/fly/wrapper.ts';
import { assembleVibeRunSpec } from '../packages/core/src/agents/impl/utils/vibeRunSpec.ts';
import { buildOpenCodeRunSpec } from '../packages/core/src/agents/impl/openCodeUtils.ts';
import { readVibeExportTokenUsage, VIBE_CONTAINER_RUNTIME_HOME } from '../packages/core/src/agents/impl/utils/vibeExportUsage.ts';
import { readSpritesCliPins } from '../packages/core/src/agents/runtime/sprites/spritesCliPins.ts';
import { spritesCliVersionRefusal, spritesProvidedCliVersion } from '../packages/core/src/agents/runtime/sprites/spritesCliVersions.ts';
import { agentRunNetworkPolicy, agentRunSpecNetworkPolicy } from '../packages/core/src/agents/runtime/agentRunNetworkPolicy.ts';
import { agentCommandModel, agentModelEgressHosts, baseEgressAllowlist } from '../packages/core/src/network/egressAllowlist.ts';
import { WORKSPACE_TRANSPORT_RESULT_DIR as RESULT, WORKSPACE_TRANSPORT_SCRIPT } from '../packages/core/src/git/workspaceTransportScript.ts';
import type { AgentConfig } from '../packages/core/src/agents/types.ts';
import { FakeSprites } from './helpers/fakeSprites.ts';

after(closeConnection);

const flyToken = 'FlyV1 synthetic-worker-credential';
const flyEnv = { PROPR_FLY_APP: 'agents', PROPR_FLY_API_TOKEN: flyToken, PROPR_FLY_IMAGE: 'registry.fly.io/agents@sha256:test' };
const spritesToken = 'test-org-secret';
const mistralKey = 'synthetic-mistral-key-0123456789';
const openRouterKey = 'sk-or-synthetic-0123456789abcdef';
const exported = JSON.stringify({ usage: { input_tokens: 1200, output_tokens: 300, cached_input_tokens: 200 } });
const cloneWorkspace = { hostPath: '/unused', containerPath: '/home/node/workspace', readOnly: false, mode: 'clone' as const,
    clone: { remote: 'unused', baseRef: 'base', baseCommit: '0123', branch: 'test', resultDir: RESULT, script: WORKSPACE_TRANSPORT_SCRIPT } };
const noPackages = async () => [];

function scratch(t: { after(fn: () => void): void }, prefix: string) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

/** The clone spec the workspace transport hands a remote runtime: no workspace or git binds. */
function asCloneSpec(spec: AgentRunSpec): AgentRunSpec {
    return { ...spec, workspace: cloneWorkspace, mounts: spec.mounts.filter(m => m.purpose !== 'workspace' && m.purpose !== 'git') };
}

function agentConfig(type: 'vibe' | 'opencode', configPath: string): AgentConfig {
    return { type, id: type, enabled: true, alias: type, dockerImage: 'propr/agent', configPath, supportedModels: [] } as AgentConfig;
}

/** Vibe's task spec as VibeAgent builds it: the agent configuration's ~/.vibe, the prompt file, the runtime home and the key env file. */
function vibeSpec(t: { after(fn: () => void): void }) {
    const root = scratch(t, 'remote-vibe-');
    const configPath = path.join(root, 'vibe-config');
    fs.mkdirSync(configPath);
    fs.writeFileSync(path.join(configPath, 'config.toml'), 'active_model = "devstral"\n');
    fs.writeFileSync(path.join(configPath, 'unrelated.log'), 'private');
    const prompt = path.join(root, 'prompt.txt');
    fs.writeFileSync(prompt, 'Fix the issue');
    const runtimeHome = path.join(root, 'runtime-home');
    fs.mkdirSync(runtimeHome);
    const envFile = path.join(root, 'agent.env');
    fs.writeFileSync(envFile, `MISTRAL_API_KEY=${mistralKey}\nGH_TOKEN=synthetic-github-token\n`);
    const spec = assembleVibeRunSpec({
        config: agentConfig('vibe', configPath), name: 'vibe-task', mode: 'execute', worktreePath: root, repositoryInspection: false, gitMountArgs: [],
        configMountArgs: ['-v', `${configPath}:/home/node/.vibe:ro`], promptMountArgs: ['-v', `${prompt}:/home/node/propr-prompt.txt:ro`],
        runtimeHomeMountArgs: ['-v', `${runtimeHome}:${VIBE_CONTAINER_RUNTIME_HOME}:rw`], envFilePath: envFile,
        envVars: ['-e', 'PROPR_AGENT_TYPE=vibe', '-e', `VIBE_RUNTIME_HOME=${VIBE_CONTAINER_RUNTIME_HOME}`],
        cliArgs: ['--output', 'streaming', '--prompt-file', '/home/node/propr-prompt.txt'],
    });
    return { spec: asCloneSpec(spec), runtimeHome, configPath };
}

/** OpenCode's task spec as OpenCodeAgent builds it: the agent configuration's config store and its data store of logins. */
function openCodeSpec(t: { after(fn: () => void): void }, model = 'openrouter/anthropic/claude-sonnet-4.5') {
    const root = scratch(t, 'remote-opencode-');
    const configPath = path.join(root, 'config');
    const dataPath = path.join(root, 'data');
    fs.mkdirSync(configPath);
    fs.mkdirSync(dataPath);
    fs.writeFileSync(path.join(configPath, 'opencode.json'), '{"$schema":"https://opencode.ai/config.json"}');
    fs.writeFileSync(path.join(dataPath, 'auth.json'), JSON.stringify({ openrouter: { type: 'api', key: openRouterKey } }));
    fs.writeFileSync(path.join(dataPath, 'storage.db'), 'private');
    const spec = buildOpenCodeRunSpec({ config: agentConfig('opencode', configPath), configPath, dataPath, worktreePath: root, githubToken: 'synthetic-github-token',
        gitMountArgs: [], issueNumber: 1, modelName: model, ensureConfigPath: () => {} });
    return { spec: asCloneSpec(spec), configPath, dataPath };
}

const launchFile = (launch: MachineLaunch, guestPath: string) => launch.config.files.find(file => file.guest_path === guestPath);
const decoded = (launch: MachineLaunch, guestPath: string) => Buffer.from(launchFile(launch, guestPath)!.raw_value, 'base64').toString();

test('Fly Machines and Sprites accept Vibe and OpenCode and still refuse other agent types', () => {
    const fly = new FlyMachinesRuntime({} as MachinesApi, flyEnv, noPackages);
    const sprites = new SpritesRuntime(new FakeSprites(), { PROPR_SPRITES_TOKEN: spritesToken }, undefined, noPackages);
    const spec = (agentType: AgentRunSpec['profile']['agentType']) => ({ profile: { agentType, image: 'propr/agent' } }) as AgentRunSpec;
    for (const type of ['claude', 'codex', 'vibe', 'opencode'] as const) {
        assert.equal(fly.unsupportedAgentConfig(null, spec(type)), undefined, type);
        assert.equal(sprites.unsupportedAgentConfig({ type }, spec(type)), undefined, type);
    }
    assert.match(fly.unsupportedAgentConfig(null, spec('antigravity'))!, /Claude Code, Codex, Mistral Vibe and OpenCode/);
    assert.equal(sprites.unsupportedAgentConfig({ type: 'antigravity' }, spec('antigravity')), undefined);
});

test('Sprites run the Dockerfile.agent pins of OpenCode and Vibe and refuse any other CLI version', () => {
    const dockerfile = fs.readFileSync('Dockerfile.agent', 'utf8');
    const pins = readSpritesCliPins();
    for (const name of ['OPENCODE_CLI_VERSION', 'VIBE_CLI_VERSION', 'VIBE_PYTHON_VERSION', 'UV_VERSION'] as const) {
        assert.match(dockerfile, new RegExp(`^ARG ${name}=${pins[name].replaceAll('.', '\\.')}$`, 'm'), name);
    }
    assert.equal(spritesProvidedCliVersion('opencode', pins), pins.OPENCODE_CLI_VERSION);
    assert.equal(spritesProvidedCliVersion('vibe', pins), pins.VIBE_CLI_VERSION);
    assert.equal(spritesCliVersionRefusal({ type: 'vibe' }, pins), undefined);
    assert.match(spritesCliVersionRefusal({ type: 'opencode', alias: 'oc', cliVersionType: 'specific', cliVersion: '0.0.1' }, pins)!,
        new RegExp(`runs only opencode CLI ${pins.OPENCODE_CLI_VERSION.replaceAll('.', '\\.')}`));
});

test('Sprite setup installs and verifies the pinned OpenCode and Vibe CLIs and their entrypoints before the clean checkpoint', () => {
    const setup = fs.readFileSync('scripts/sprites-agent-setup.sh', 'utf8');
    assert.match(setup, /pin_npm_cli opencode-ai "\$OPENCODE_CLI_VERSION" opencode/);
    assert.match(setup, /pin_uv "\$UV_VERSION"\npin_vibe "\$VIBE_CLI_VERSION" "\$VIBE_PYTHON_VERSION"/);
    assert.match(setup, /uv" tool install --force --python "\$python" "mistral-vibe==\$version"/);
    assert.match(setup, /installed_version su-exec node "\$bin_dir\/vibe" \| grep -qF "\$version"/);
    assert.match(setup, /opencode-entrypoint\.sh vibe-entrypoint\.sh; do/);
    assert.match(setup, /install -m 0755 "\$source_dir\/opencode-run\.sh" \/usr\/local\/bin\/opencode-run/);
    const listed = spawnSync('bash', ['-c', 'source scripts/sprites-agent-setup.sh; declare -F pin_uv pin_vibe'], { encoding: 'utf8' });
    assert.equal(listed.status, 0, listed.stderr);
});

test('Fly: a Vibe run gets its configured files, prompt and runtime home in the Machine, and its usage export back', async t => {
    const { spec, runtimeHome } = vibeSpec(t);
    const prepared = prepareLaunch(spec, {}, flyConfig(flyEnv));
    const { launch } = prepared;
    assert.equal(decoded(launch, '/home/node/.vibe/config.toml'), 'active_model = "devstral"\n');
    assert.ok(!launch.config.files.some(file => file.guest_path.endsWith('unrelated.log')), 'only the Vibe manifest files travel');
    assert.equal(decoded(launch, '/home/node/propr-prompt.txt'), 'Fix the issue');
    assert.equal(launchFile(launch, '/home/node/propr-prompt.txt')!.mode, 0o644);
    const input = JSON.parse(decoded(launch, RUN + '/input'));
    assert.ok(input.directories.includes(VIBE_CONTAINER_RUNTIME_HOME));
    assert.equal(input.credentialPath, undefined, 'Vibe refreshes nothing, so nothing is pending write-back');
    const agent = JSON.parse(decoded(launch, '/opt/propr/fly-agent.json'));
    assert.equal(agent.argv[0], '/home/node/vibe-entrypoint.sh');
    assert.equal(agent.env.MISTRAL_API_KEY, mistralKey);
    assert.ok(prepared.secrets.includes(mistralKey), 'the Mistral key is redacted from the output');

    const exports: string[] = [];
    const api = {
        async exec(_id: string, args: string[]) {
            assert.deepEqual(args.slice(0, 2), ['su-exec', 'node']);
            exports.push(args.at(-1)!);
            return { exit_code: 0, stdout: JSON.stringify([Date.now(), Buffer.from(exported).toString('base64')]) };
        },
    } as unknown as MachinesApi;
    await prepared.collectRuntimeFiles(api, 'machine');
    assert.deepEqual(exports, [VIBE_CONTAINER_RUNTIME_HOME + '/propr-export/export.json']);
    assert.deepEqual(readVibeExportTokenUsage(runtimeHome), { input_tokens: 1000, output_tokens: 300, cache_read_input_tokens: 200 });
});

test('Fly: an OpenCode run gets both configured stores, redacts the provider key and writes rotated logins back', async t => {
    const { spec, dataPath } = openCodeSpec(t);
    const prepared = prepareLaunch(spec, { stdinData: 'Fix the issue' }, flyConfig(flyEnv));
    const { launch } = prepared;
    assert.equal(decoded(launch, '/home/node/.config/opencode/opencode.json'), '{"$schema":"https://opencode.ai/config.json"}');
    assert.match(decoded(launch, '/home/node/.local/share/opencode-source/auth.json'), /openrouter/);
    assert.ok(!launch.config.files.some(file => file.guest_path.endsWith('storage.db')), 'only the OpenCode manifest files travel');
    const agent = JSON.parse(decoded(launch, '/opt/propr/fly-agent.json'));
    assert.equal(agent.argv[0], '/home/node/opencode-entrypoint.sh');
    assert.deepEqual(agent.argv.slice(1, 3), ['opencode-run', '--format']);
    assert.ok(prepared.secrets.includes(openRouterKey), 'the stored provider key is redacted from the output');
    const input = JSON.parse(decoded(launch, RUN + '/input'));
    assert.match(input.credentialPath, /\/home\/node\/\.local\/share\/opencode-source/);

    const rotated = JSON.stringify({ openrouter: { type: 'api', key: 'sk-or-rotated-0123456789abcdef' } });
    const exports: string[] = [];
    const api = {
        async exec(_id: string, args: string[]) {
            const file = args.at(-1)!;
            exports.push(file);
            if (file !== '/home/node/.local/share/opencode-source/auth.json') return { exit_code: 0, stdout: 'null' };
            return { exit_code: 0, stdout: JSON.stringify([Date.now() + 1000, Buffer.from(rotated).toString('base64')]) };
        },
    } as unknown as MachinesApi;
    await prepared.commit(api, 'machine');
    assert.ok(exports.includes('/home/node/.local/share/opencode-source/account.json'));
    assert.equal(fs.readFileSync(path.join(dataPath, 'auth.json'), 'utf8'), rotated);
});

test('Fly: a full OpenCode run keeps the stored provider key out of the captured output', async t => {
    const { spec } = openCodeSpec(t);
    let launch: MachineLaunch | undefined;
    let started = false;
    const api: MachinesApi = {
        async create(value: MachineLaunch) { launch = value; return 'machine'; },
        async logs() { throw new Error('no live logs'); },
        async exec(_id: string, args: string[]) {
            if (args[0] === '/usr/bin/touch') { started = true; return { stdout: '', exit_code: 0 }; }
            if (args[0] === 'su-exec') return { stdout: 'null', exit_code: 0 };
            if (args[0] === '/bin/rm' || args[0] === '/bin/mv') return { stdout: '', exit_code: 0 };
            const [op, file, offset, length] = args.slice(3);
            if (op === 'probe') return { stdout: started ? 'exited 0\n0\n' : 'ready\n0', exit_code: 0 };
            const files: Record<string, Buffer> = {
                [RUN + '/stdout']: Buffer.from(`{"type":"text","part":{"text":"used ${openRouterKey}"}}\n`), [RUN + '/stderr']: Buffer.alloc(0),
                [RUN + '/workspace/status']: Buffer.from('bundle test'), [RUN + '/workspace/result.bundle']: Buffer.from([1]),
            };
            const data = files[file];
            if (op === 'size') return { stdout: String(data?.length), exit_code: data ? 0 : 44 };
            return { stdout: data!.subarray(+offset, +offset + +length).toString('base64'), exit_code: 0 };
        },
        async signal() {}, async destroy() {}, async gone() { return true; }, async find() { return undefined; },
    } as unknown as MachinesApi;
    const run = new FlyMachinesRuntime(api, flyEnv, noPackages).start(spec, { stdinData: 'Fix the issue' });
    const result = await run.wait();
    assert.equal(result.exitCode, 0);
    assert.ok(!result.stdout.includes(openRouterKey));
    assert.match(result.stdout, /\[REDACTED\]/);
    assert.ok(!JSON.stringify(launch!.config.env ?? {}).includes(openRouterKey), 'the key travels only as a credential file, not in the Machine env');
    await run.release!();
});

test('Sprites: Vibe and OpenCode runs upload every configured store, the prompt file and collect the usage export', async t => {
    const vibe = vibeSpec(t);
    const client = new FakeSprites();
    const reads: string[] = [];
    client.setup = sprite => {
        const execFile = sprite.execFile.bind(sprite);
        sprite.execFile = async (cmd, args, options) => {
            if (args.includes('read-file')) {
                reads.push(args.at(-1)!);
                return { exitCode: 0, stdout: JSON.stringify({ content: Buffer.from(exported).toString('base64'), mtimeMs: 1 }), stderr: '' };
            }
            return execFile(cmd, args, options);
        };
    };
    const runtime = new SpritesRuntime(client, { PROPR_SPRITES_TOKEN: spritesToken }, undefined, noPackages);
    t.after(() => runtime.close());
    const run = runtime.start(vibe.spec);
    assert.equal((await run.wait()).exitCode, 0);
    const input = JSON.parse(client.created[0].launches[0]);
    assert.deepEqual(input.agent.stores, ['/home/node/.vibe']);
    assert.deepEqual(input.files.map(([file]: [string]) => file), ['0/config.toml']);
    assert.deepEqual(input.prompts, [['/home/node/propr-prompt.txt', Buffer.from('Fix the issue').toString('base64')]]);
    assert.ok(input.agent.directories.includes(VIBE_CONTAINER_RUNTIME_HOME));
    assert.ok(input.agent.argv.includes('/opt/propr/entrypoints/vibe-entrypoint.sh'));
    assert.equal(input.agent.env.MISTRAL_API_KEY, mistralKey);
    assert.deepEqual(reads, ['/opt/propr/run/tmp/propr-vibe-home/propr-export/export.json']);
    assert.equal(readVibeExportTokenUsage(vibe.runtimeHome)?.output_tokens, 300);
    await run.release!();

    const openCode = openCodeSpec(t);
    const second = runtime.start(openCode.spec, { stdinData: 'Fix the issue' });
    assert.equal((await second.wait()).exitCode, 0);
    const upload = JSON.parse(client.created.at(-1)!.launches.at(-1)!);
    assert.deepEqual(upload.agent.stores, ['/home/node/.config/opencode', '/home/node/.local/share/opencode-source']);
    assert.deepEqual(upload.files.map(([file]: [string]) => file).sort(), ['0/opencode.json', '1/auth.json']);
    // Both stores' refreshable logins (the config store's xdg-data fallback and the data store) come back.
    assert.deepEqual(upload.agent.outputs, ['/home/node/.config/opencode/xdg-data/opencode/auth.json', '/home/node/.config/opencode/xdg-data/opencode/account.json',
        '/home/node/.local/share/opencode-source/auth.json', '/home/node/.local/share/opencode-source/account.json']);
    assert.ok(upload.agent.argv.includes('/opt/propr/entrypoints/opencode-entrypoint.sh'));
    await second.release!();
});

test('the Sprite launcher installs each store and prompt file and reads a run file as a non-root user', { skip: process.platform !== 'linux' }, t => {
    const dir = scratch(t, 'sprite-launcher-');
    const file = path.join(dir, 'export.json');
    fs.writeFileSync(file, exported);
    fs.symlinkSync(file, path.join(dir, 'link'));
    const read = (target: string) => spawnSync('python3', ['-I', '-c',
        'import runpy,sys,pathlib; runpy.run_path("scripts/sprites-launcher.py")["read_file"](pathlib.Path(sys.argv[1]))', target], { encoding: 'utf8' });
    if (process.getuid?.() === 0) return;
    assert.equal(JSON.parse(read(file).stdout).content, Buffer.from(exported).toString('base64'));
    assert.equal(read(path.join(dir, 'missing')).stdout.trim(), 'null');
    assert.notEqual(read(path.join(dir, 'link')).status, 0, 'a link is never followed');
    const prompt = spawnSync('python3', ['-I', '-c',
        'import runpy; runpy.run_path("scripts/sprites-launcher.py")["install_prompts"]([["/etc/propr-prompt", "eA=="]])'], { encoding: 'utf8' });
    assert.match(prompt.stderr, /Invalid prompt file path/);
});

test('restricted networking: Vibe reaches Mistral; OpenCode reaches the provider of its configured model', t => {
    assert.ok(baseEgressAllowlist('vibe').includes('api.mistral.ai'));
    assert.deepEqual(agentModelEgressHosts('opencode', 'groq/llama-3.3-70b'), ['api.groq.com']);
    assert.deepEqual(agentModelEgressHosts('opencode', 'mistral/devstral-medium'), ['api.mistral.ai']);
    assert.deepEqual(agentModelEgressHosts('opencode', 'unknown/model'), []);
    assert.deepEqual(agentModelEgressHosts('claude', 'groq/llama'), []);
    // Docker's proxy reads the model from the same docker run argv (memory flags are not a model).
    assert.equal(agentCommandModel(['run', '--memory', '6g', '-m', '6g', 'propr/agent', 'opencode-run', '--model', 'groq/llama']), 'groq/llama');
    assert.equal(agentCommandModel(['opencode-run', '--model=xai/grok-4']), 'xai/grok-4');
    assert.ok(baseEgressAllowlist('opencode', 'xai/grok-4').includes('api.x.ai'));
    const restriction = { source: 'instance_enforced', allow: [], instanceAllow: [] } as unknown as Parameters<typeof agentRunNetworkPolicy>[1];
    const { spec } = openCodeSpec(t, 'deepseek/deepseek-chat');
    const hosts = agentRunSpecNetworkPolicy(spec, restriction).allow.map(rule => rule.host);
    assert.ok(hosts.includes('api.deepseek.com'));
    assert.ok(hosts.includes('opencode.ai'));
    assert.ok(!agentRunNetworkPolicy('opencode', restriction).allow.some(rule => rule.host === 'api.deepseek.com'));
});
