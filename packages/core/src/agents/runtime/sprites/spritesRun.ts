import fs from 'node:fs';
import path from 'node:path';
import type { Sprite } from '@fly/sprites';
import { WORKSPACE_DIRECT_AGENT_LAUNCH, WORKSPACE_TRANSPORT_SCRIPT, WORKSPACE_TRANSPORT_RESULT_DIR, WORKSPACE_TRANSPORT_ENVIRONMENT as E, WORKSPACE_TRANSPORT_TOKEN_ENV } from '../../../git/workspaceTransportScript.js';
import { CredentialBroker, MAX_RETURNED_CREDENTIAL_BYTES, readRegularFileInside } from '../../credentials/broker.js';
import { credentialRunRoot, envFileValues } from '../../credentials/hostCredentialStaging.js';
import { CLAUDE_JSON_SEED_CONTAINER_PATH as SEED } from '../../../claude/docker/claudeConfigSeed.js';
import type { AgentRunOptions } from '../dockerRuntime.js';
import type { AgentRunMount, AgentRunSpec } from '../types.js';

const PATH = '/opt/propr/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const antigravityHome = '/opt/propr/run/tmp/propr-antigravity-home';
const stores = { claude: '/home/node/.claude', codex: '/home/node/.codex', antigravity: antigravityHome + '/.gemini' };
export const spriteLauncher = '/opt/propr/launcher.py';
const python = ['/usr/bin/python3', '-I', spriteLauncher];
type Bind = Extract<AgentRunMount, { type: 'bind' }>;

export function unsupportedMount(mount: Bind): string | undefined {
    if (mount.credentialStore?.perRun && mount.credentialStore.store === 'config') return;
    if (mount.target === SEED && mount.readOnly && mount.purpose === 'credential') return;
    if (['logs', 'scratch'].includes(mount.purpose) && mount.target.startsWith('/tmp/') && path.normalize(mount.target) === mount.target) return;
    return `cannot provide the ${mount.purpose} mount at ${mount.target}`;
}

function supportedBinds(spec: AgentRunSpec) {
    const binds = spec.mounts.filter((mount): mount is Bind => mount.type === 'bind');
    for (const bind of binds) {
        const reason = unsupportedMount(bind);
        if (reason) throw new Error(reason);
    }
    return binds;
}

type EnvDefaults = ReadonlyArray<readonly [string, string]>;

export function resolveRunEnvironment({ spec, options }: Pick<SpriteLaunch, 'spec' | 'options'>, defaults: EnvDefaults = [], validateOnly = false) {
    const inherited = { ...process.env, ...options.extraEnvVars };
    // An env file may override any extra. Scan only known effective values during validation.
    const extras = validateOnly && spec.envFiles.length ? {} : options.extraEnvVars;
    const env = new Map(Object.entries(extras ?? {}));
    for (const file of [...spec.envFiles].sort((a, b) => a.order - b.order)) {
        fs.accessSync(file.path, fs.constants.R_OK);
        if (validateOnly) continue;
        for (const [name, value] of envFileValues(file.path, inherited)) env.set(name, value);
    }
    for (const variable of [...(spec.repoSetup?.env ?? []), ...[...spec.env].sort((a, b) => a.order - b.order)]) {
        const value = variable.value ?? inherited[variable.name];
        if (value === undefined) env.delete(variable.name);
        else env.set(variable.name, value);
    }
    for (const [name, value] of defaults) {
        if (!env.has(name)) env.set(name, value);
    }
    const transportToken = env.get(WORKSPACE_TRANSPORT_TOKEN_ENV) ?? '';
    env.delete(WORKSPACE_TRANSPORT_TOKEN_ENV);
    for (const name of Object.values(E)) env.delete(name);
    return { env, transportToken };
}

function runEnvironment(launch: SpriteLaunch, defaults: EnvDefaults, validateOnly = false) {
    const { env, transportToken } = resolveRunEnvironment(launch, defaults, validateOnly);
    const { token } = launch;
    for (const [name, value] of env) {
        if (['SPRITES_TOKEN', 'PROPR_SPRITES_TOKEN', 'PROPR_SPRITES_LIVE_TOKEN'].includes(name) || value.includes(token)) env.delete(name);
    }
    env.delete('PROPR_ANTIGRAVITY_SOURCE_CONFIG');
    env.delete('PROPR_ANTIGRAVITY_TRANSCRIPT_PATH');
    return { env, transportToken };
}

function claudeSeed(binds: Bind[], token: string): string | undefined {
    const seed = binds.find(m => m.target === SEED);
    if (!seed) return undefined;
    const read = readRegularFileInside(path.dirname(seed.source), path.basename(seed.source), MAX_RETURNED_CREDENTIAL_BYTES);
    if (!read || read === 'oversized') throw new Error('Invalid Claude configuration seed');
    if (read.content.includes(token)) throw new Error('Sprites org credential found in Claude configuration');
    return read.content.toString('base64');
}

export type SpriteLaunch = { spec: AgentRunSpec; options: AgentRunOptions; token: string; inputPath: string };
function writableClone(spec: AgentRunSpec) {
    const { clone, mode, readOnly, containerPath } = spec.workspace;
    if (mode !== 'clone' || readOnly || containerPath !== '/home/node/workspace' ||
        !clone?.remote || !clone.baseRef || !clone.baseCommit || !clone.branch ||
        clone.resultDir !== WORKSPACE_TRANSPORT_RESULT_DIR || clone.script !== WORKSPACE_TRANSPORT_SCRIPT) {
        throw new Error('Sprites requires a prepared writable clone workspace');
    }
    return clone;
}

export function validateSpriteRun(launch: SpriteLaunch, defaults: EnvDefaults = []) {
    const { spec, options, token } = launch;
    const clone = writableClone(spec);
    const provider = spec.profile.agentType;
    if (!Object.hasOwn(stores, provider)) throw new Error(`Unsupported Sprites provider: ${provider}`);
    const binds = supportedBinds(spec);
    const { env, transportToken } = runEnvironment(launch, defaults, true);
    const credentials = binds.filter(m => m.credentialStore).map(m => {
        if (m.credentialStore!.provider !== provider) throw new Error('Mismatched Sprite credential store');
        return { id: 'config', provider, store: 'config' as const, canonicalRoot: m.source };
    });
    const argv = spec.repoSetup
        ? ['/bin/bash', '-c', spec.repoSetup.script, `/opt/propr/entrypoints/${provider}-entrypoint.sh`, ...spec.args]
        : [spec.entrypoint ?? `/opt/propr/entrypoints/${provider}-entrypoint.sh`, ...spec.args];
    const transportEnv = { PATH, HOME: '/root', [E.path]: spec.workspace.containerPath, [E.remote]: clone.remote,
        [E.branch]: clone.branch, [E.baseRef]: clone.baseRef, [E.baseCommit]: clone.baseCommit,
        [E.resultRef]: clone.resultRef ?? '', [E.resultDir]: '/opt/propr/result' };
    const stdin = options.stdinData ?? '';
    const directories = binds.filter(m => ['logs', 'scratch'].includes(m.purpose)).map(m => m.target);
    checkPayload(JSON.stringify({ argv, directories, transportEnv, transportToken, stdin, env: Object.fromEntries(env) }), token);
    return { provider, binds, credentials, argv, directories, transportEnv, stdin };
}

function checkPayload(payload: string, token: string) {
    if (payload.includes(token)) throw new Error('Refusing to upload the Sprites organization credential');
}

export function prepareSpriteRun(launch: SpriteLaunch,
    validated: ReturnType<typeof validateSpriteRun>, defaults: EnvDefaults = []) {
    const { options, token, inputPath } = launch;
    const { provider, binds, credentials, argv } = validated;
    const { env, transportToken } = runEnvironment(launch, defaults);
    env.set('PROPR_EXECUTION_TIMEOUT_MS', String(options.timeout ?? 300_000));
    const home = provider === 'antigravity' ? antigravityHome : '/home/node';
    Object.entries({ PATH, HOME: home, USER: 'node', LOGNAME: 'node', LANG: 'C.UTF-8', DISABLE_AUTOUPDATER: '1', AGY_CLI_DISABLE_AUTO_UPDATE: 'true' })
        .forEach(([key, value]) => env.set(key, value));
    const broker = new CredentialBroker({ lock: { lockRoot: path.join(credentialRunRoot(), '.locks') } });
    const bundle = broker.materialize(credentials, { definedEnv: [...env].filter(([, value]) => value).map(([key]) => key) });
    const store = bundle.stores[0];
    const files = store?.files.map(f => {
        if (f.content.includes(token)) throw new Error('Sprites org credential found in provider store');
        return [f.path, f.content.toString('base64'), Boolean(f.mode & 0o111)];
    }) ?? [];
    const liveStore = stores[provider as keyof typeof stores];
    const directories = [home, ...validated.directories,
        ...(store?.directories.map(dir => path.join(liveStore, dir)) ?? [])];
    const environment = { ...Object.fromEntries(env), ...bundle.secretEnv };
    const upload = JSON.stringify({
        transport: ['/bin/bash', '-c', WORKSPACE_TRANSPORT_SCRIPT, WORKSPACE_DIRECT_AGENT_LAUNCH, ...python, 'agent'],
        transportEnv: { ...validated.transportEnv, [WORKSPACE_TRANSPORT_TOKEN_ENV]: transportToken },
        stdin: validated.stdin, files,
        agent: { env: environment, argv, directories, claudeSeed: claudeSeed(binds, token),
            store: store ? liveStore : null, outputs: store?.outputs ?? [] },
    });
    checkPayload(upload, token);
    return {
        environment,
        markerArgs: env.get('PROPR_REPO_SETUP') === '0' ? [] : argv,
        upload: (sprite: Sprite) => sprite.filesystem().writeFile(inputPath, upload, { mode: 0o600 }),
        commit,
    };
    async function commit(sprite: Sprite) {
        if (!store?.outputs.length) return;
        // The SDK stat/read calls follow links. Run the descriptor-based reader on
        // the Sprite. Only the launcher's unprivileged child reads the live credentials.
        const limits = {
            cwd: '/', timeout: 30_000, maxBuffer: 2 * MAX_RETURNED_CREDENTIAL_BYTES * store.outputs.length,
        };
        await sprite.execFile('sudo', ['-n', ...python, 'export'], limits);
        const { stdout } = await sprite.execFile(python[0], [...python.slice(1), 'read-export', String(store.outputs.length)], limits);
        const records: Array<{ index: number; content: string; mtimeMs: number }> = JSON.parse(stdout.toString());
        await broker.commit(bundle, records.map(record => {
            const content = Buffer.from(record.content, 'base64');
            if (!Number.isInteger(record.index) || !store.outputs[record.index] || !Number.isFinite(record.mtimeMs) || content.length > MAX_RETURNED_CREDENTIAL_BYTES)
                throw new Error('Invalid Sprite credential export');
            return { storeId: store.id, path: store.outputs[record.index], content, mtimeMs: record.mtimeMs };
        }));
    }
}
