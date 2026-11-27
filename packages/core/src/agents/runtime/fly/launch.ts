import { providerCredentialManifest } from '../../credentials/providerManifests.js';
import { PROPR_MCP_BEARER_TOKEN_ENV } from '../../agentToolPolicy.js';
import { extensionSkillPath, resolveRunEnvironment } from '../sprites/spritesRun.js';
import { EXTENSION_SKILLS_ROOT, type ExtensionSkillFile } from '../../../extensions/extensionLaunchContext.js';
import path from 'node:path';
import { parseJsonc } from '../../../utils/jsonUtils.js';
import { randomUUID } from 'node:crypto';
import { CLAUDE_BACKUPS_CONTAINER_PATH, CLAUDE_JSON_SEED_CONTAINER_PATH as SEED } from '../../../claude/docker/claudeConfigSeed.js';
import { WORKSPACE_TRANSPORT_SCRIPT, WORKSPACE_DIRECT_AGENT_LAUNCH, WORKSPACE_TRANSPORT_RESULT_DIR,
    WORKSPACE_TRANSPORT_ENVIRONMENT as E, WORKSPACE_TRANSPORT_TOKEN_ENV } from '../../../git/workspaceTransportScript.js';
import { CredentialBroker, MAX_RETURNED_CREDENTIAL_BYTES, readRegularFileInside, type CredentialStoreBundle, type CredentialStoreRequest, type ReturnedCredentialFile } from '../../credentials/broker.js';
import { credentialRunRoot } from '../../credentials/hostCredentialStaging.js';
import type { AgentRunOptions } from '../dockerRuntime.js';
import type { AgentRunMount, AgentRunSpec } from '../types.js';
import type { MachineLaunch, MachinesApi } from './api.js';
import type { FlyConfig } from './config.js';
import { RUN, AGENT, WRAPPER, PACKAGE_SERVERS, wrapper } from './wrapper.js';
import { PACKAGE_SERVER_INSTALLER, packageServerInstallSpec, type RemotePackageInstall } from '../../../extensions/remotePackageServers.js';
import { FLY_PATH as PATH, flyPackageInstallSpec } from './packages.js';
import { isRemoteAgentType, isRemotePromptMount, readRemotePromptFile, remoteRuntimeHome, unsupportedRemoteRunMount,
    writeReturnedRuntimeFile, type RemoteAgentType, type RemoteRuntimeHome } from '../remoteRunMounts.js';
import logger from '../../../utils/logger.js';

export const helper = ['/usr/bin/python3', '-I', WRAPPER];
const shim = '/opt/propr/fly-provider';
type Bind = Extract<AgentRunMount, { type: 'bind' }>;
export function unsupportedFlyMount(m: Bind) {
    // The agent configuration's credential stores (per-run copies), Vibe's prompt file and runtime home.
    if (m.credentialStore) return unsupportedRemoteRunMount(m);
    if (m.target === SEED && m.readOnly && m.purpose === 'credential') return;
    if (['scratch', 'logs'].includes(m.purpose) && !m.readOnly && /^\/tmp\/[\w-]+(?:\/[\w-]+)*$/.test(m.target)) return;
    return unsupportedRemoteRunMount(m);
}

/** What Fly Machines refuses for an agent type, or undefined for Claude Code, Codex, Mistral Vibe and OpenCode. */
export function unsupportedFlyAgentType(type: string): string | undefined {
    return isRemoteAgentType(type) ? undefined : 'Fly Machines supports Claude Code, Codex, Mistral Vibe and OpenCode';
}

function validateLaunch(spec: AgentRunSpec, options: AgentRunOptions) {
    const { clone, containerPath } = spec.workspace;
    if (options.extraMounts?.length || spec.security.readOnlyRootFilesystem || spec.security.capDrop.length ||
        spec.security.securityOpts.some(opt => !['no-new-privileges', 'seccomp=unconfined', 'apparmor=unconfined'].includes(opt))) {
        throw new Error('Fly Machines cannot provide the requested mount or security restrictions');
    }
    if (spec.workspace.mode !== 'clone' || spec.workspace.readOnly || containerPath !== '/home/node/workspace'
        || clone?.script !== WORKSPACE_TRANSPORT_SCRIPT || clone.resultDir !== WORKSPACE_TRANSPORT_RESULT_DIR)
        throw new Error('Fly Machines requires a prepared writable clone workspace');
    const provider = spec.profile.agentType;
    const refusal = unsupportedFlyAgentType(provider);
    if (refusal || !isRemoteAgentType(provider)) throw new Error(refusal);
    return { clone, containerPath, provider } as const;
}

type AddFile = (target: string, content: string | Buffer, mode?: number) => void;

function prepareMounts(mounts: readonly AgentRunMount[], provider: RemoteAgentType, add: AddFile) {
    const directories = new Set<string>();
    const requests: CredentialStoreRequest[] = [];
    /** Each credential store's path in the Machine, by store id. */
    const storePaths = new Map<string, string>();
    const runtimeHomes: RemoteRuntimeHome[] = [];
    let backupTmpfs = false;
    for (const m of mounts) {
        if (m.type === 'tmpfs') {
            if (m.target !== CLAUDE_BACKUPS_CONTAINER_PATH || m.options !== 'rw,nosuid,nodev,noexec,size=16m') throw new Error('Unsupported Fly tmpfs target');
            backupTmpfs = true;
            directories.add(m.target);
            continue;
        }
        const reason = unsupportedFlyMount(m);
        if (reason) throw new Error(reason);
        if (m.credentialStore) {
            const { store } = m.credentialStore;
            if (m.credentialStore.provider !== provider || storePaths.has(store)) throw new Error('Mismatched Fly credential store');
            requests.push({ provider, id: store, store, canonicalRoot: m.source });
            storePaths.set(store, m.target);
        } else if (m.target === SEED) {
            const file = readRegularFileInside(path.dirname(m.source), path.basename(m.source), MAX_RETURNED_CREDENTIAL_BYTES);
            if (!file || file === 'oversized') throw new Error('Invalid Claude configuration seed');
            add(SEED, file.content);
        } else if (isRemotePromptMount(m)) {
            // Root-owned and read-only for the agent, like Docker's read-only bind.
            add(m.target, readRemotePromptFile(m), 0o644);
        } else {
            // Scratch, logs and a runtime home: a directory in the Machine, created for this run.
            const home = remoteRuntimeHome(m);
            if (home) runtimeHomes.push(home);
            directories.add(m.target);
        }
    }
    return { requests, storePaths, runtimeHomes, directories, backupTmpfs };
}

/** Credential-shaped JSON keys (Claude, Codex and OpenCode logins) whose values are redacted from the output. */
const CREDENTIAL_KEY = /^(?:(?:access|refresh|id|auth)_?)?token$|^(?:openai_)?api_?key$|^(?:access|refresh|key)$/i;
/** Environment names that carry a provider credential (OpenCode reads its provider keys from these). */
const CREDENTIAL_ENV = /(?:API_?KEY|TOKEN|SECRET|PASSWORD)$/i;

/** The run's credential store files: what the Machine gets, the node user owns and the output redacts. */
interface StagedCredentials { add: AddFile; directories: Set<string>; owned: string[]; secrets: string[] }

function stageCredentials(store: CredentialStoreBundle, storePath: string, staged: StagedCredentials) {
    const { add, directories, owned, secrets } = staged;
    directories.add(storePath);
    for (const directory of store.directories) directories.add(path.join(storePath, directory));
    for (const file of store.files) {
        const target = path.join(storePath, file.path);
        add(target, file.content, file.mode & 0o111 ? 0o700 : 0o600);
        owned.push(target);
        directories.add(path.dirname(target));
        // Protect credential strings even when the CLI prints only one field.
        // JSONC too: OpenCode's opencode.jsonc may carry comments and trailing commas around a provider apiKey.
        try { parseJsonc(file.content.toString(), (key, value) => {
            if (typeof value === 'string' && CREDENTIAL_KEY.test(key)) secrets.push(value);
            return value;
        }); } catch { if (file.refresh) secrets.push(file.content.toString().trim()); }
    }
}

function providerArgv(spec: AgentRunSpec, provider: RemoteAgentType) {
    if (!spec.args.length) throw new Error('Fly Machines needs a provider command');
    return [spec.repoSetup?.providerEntrypoint ?? spec.entrypoint ?? `/home/node/${provider}-entrypoint.sh`, ...spec.args];
}

/** What the run's extension launch adds to the Machine: skill bundle files, package servers to install and secrets to redact. */
export interface FlyExtensionLaunch { skillFiles?: readonly ExtensionSkillFile[]; secrets?: readonly string[]; packageInstall?: RemotePackageInstall }

export { PACKAGE_SERVERS };

/** Fly Machine create requests carry every file base64-encoded in the config; refuse a launch past this before sending it. */
export const MAX_FLY_MACHINE_CONFIG_BYTES = 4 * 1024 * 1024;

/** Library skill bundles: root-owned and read-only for the agent, like Docker's read-only mount. */
function stageExtension(extension: FlyExtensionLaunch | undefined, add: AddFile) {
    const files = extension?.skillFiles ?? [];
    for (const file of files) add(`${EXTENSION_SKILLS_ROOT}/${extensionSkillPath(file.path)}`, file.content, 0o444);
    // Package servers are installed by root at Machine start, before the agent (none: no install step at all).
    const packageServers = extension?.packageInstall?.servers ?? [];
    if (packageServers.length) {
        add(PACKAGE_SERVERS.installer, PACKAGE_SERVER_INSTALLER, 0o644);
        add(PACKAGE_SERVERS.spec, packageServerInstallSpec(extension!.packageInstall!));
    }
    return { secrets: extension?.secrets ?? [], skills: files.length > 0, packageServers };
}

const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

/** A clear refusal, before any Machine is created, for a configuration Fly would reject with an opaque create error. */
function assertMachineConfigSize(bytes: number, extension: FlyExtensionLaunch | undefined) {
    if (bytes <= MAX_FLY_MACHINE_CONFIG_BYTES) return;
    const skillBytes = (extension?.skillFiles ?? []).reduce((sum, file) => sum + file.content.length, 0);
    const lockBytes = (extension?.packageInstall?.servers ?? []).reduce((sum, server) => sum + Buffer.byteLength(server.lock) + Buffer.byteLength(server.packageJson), 0);
    throw new Error(`Fly Machine configuration is ${mib(bytes)}, over the ${mib(MAX_FLY_MACHINE_CONFIG_BYTES)} limit for one Machine create request. `
        + `It carries ${mib(skillBytes)} of skill bundle files and ${mib(lockBytes)} of package server lock files (base64-encoded in the request). `
        + 'Remove large skill bundles or package MCP servers from the run, or run it on the sprites or docker runtime.');
}

export function prepareLaunch(spec: AgentRunSpec, options: AgentRunOptions, config: FlyConfig, extension?: FlyExtensionLaunch) {
    const { clone, containerPath, provider } = validateLaunch(spec, options);
    const files: MachineLaunch['config']['files'] = [];
    const add = (guest_path: string, content: string | Buffer, mode = 0o600) => {
        const bytes = Buffer.from(content);
        if (bytes.includes(config.token)) throw new Error('Refusing to upload the Fly API credential');
        files.push({ guest_path, mode, raw_value: bytes.toString('base64') });
    };
    const { env, transportToken } = resolveRunEnvironment({ spec, options });
    for (const [name, value] of env) {
        if (/^(?:PROPR_)?FLY_(?:(?:API|LIVE)_)?TOKEN$/.test(name) || value.includes(config.token)) env.delete(name);
    }
    const { requests, storePaths, runtimeHomes, directories, backupTmpfs } = prepareMounts(spec.mounts, provider, add);
    const broker = new CredentialBroker({ lock: { lockRoot: path.join(credentialRunRoot(), '.locks') } });
    const bundle = broker.materialize(requests, { definedEnv: [...env].filter(([, v]) => v).map(([k]) => k) });
    // Each store of the agent configuration (OpenCode has a config and a data store) at its provider path.
    const storePath = (store: CredentialStoreBundle) => storePaths.get(store.id)!;
    const staged: StagedCredentials = { add, directories, owned: [], secrets: [] };
    for (const store of bundle.stores) stageCredentials(store, storePath(store), staged);
    const { owned, secrets: storeSecrets } = staged;
    const returning = bundle.stores.filter(store => store.outputs.length);
    const credentialNames = [...providerCredentialManifest(provider, 'config')?.apiKeyEnv ?? [], 'OPENAI_API_KEY',
        'ANTHROPIC_AUTH_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_ACCESS_TOKEN', PROPR_MCP_BEARER_TOKEN_ENV,
        ...[...env.keys()].filter(name => CREDENTIAL_ENV.test(name))];
    const extensionStaged = stageExtension(extension, add);
    const secrets = [transportToken, ...extensionStaged.secrets, ...Object.values(bundle.secretEnv), ...storeSecrets, ...credentialNames.map(k => env.get(k))]
        .filter((v): v is string => v !== undefined && v.length >= 12);
    const environment = { PATH, ...Object.fromEntries(env), ...bundle.secretEnv, HOME: '/home/node', USER: 'node', LOGNAME: 'node' };
    // Only trusted values enter the root shell. Provider settings such as
    // BASH_ENV, PATH and LD_PRELOAD take effect after dropping privileges.
    const transportEnv = { PATH, HOME: '/root', LANG: 'C.UTF-8', PROPR_AGENT_TYPE: provider,
        PROPR_REPO_SETUP: env.get('PROPR_REPO_SETUP') === '0' ? '0' : '1',
        PROPR_REPO_SETUP_STRICT: env.get('PROPR_REPO_SETUP_STRICT') === '1' ? '1' : '0',
        PROPR_CLAUDE_JSON_SEED: provider === 'claude' ? SEED : '',
        PROPR_EXECUTION_TIMEOUT_MS: String(options.timeout ?? 300_000),
        [E.path]: containerPath, [E.remote]: clone.remote, [E.branch]: clone.branch, [E.baseRef]: clone.baseRef,
        [E.baseCommit]: clone.baseCommit, [E.resultRef]: clone.resultRef ?? '', [E.resultDir]: RUN + '/workspace',
        [WORKSPACE_TRANSPORT_TOKEN_ENV]: transportToken };
    const setup = spec.repoSetup;
    add(AGENT, JSON.stringify({ env: environment, argv: providerArgv(spec, provider) }));
    add(WRAPPER, wrapper, 0o644);
    add(shim, '#!/bin/sh\nexec /usr/local/bin/su-exec node /usr/bin/python3 -I ' + WRAPPER + ' agent\n', 0o755);
    // Both trusted setup wrappers invoke su-exec for hook commands. Apply the
    // resolved environment on its node side while keeping workflow reports trusted.
    const hookBin = '/opt/propr/fly-hook';
    if (setup) add(hookBin + '/su-exec', '#!/bin/sh\nshift\nexec /usr/local/bin/su-exec node /usr/bin/python3 -I ' + WRAPPER + ' hook "$@"\n', 0o755);
    const command = ['/bin/bash', '-c', clone.script, ...(setup ? [`export PATH=${hookBin}:$PATH\n${setup.script}`, shim, ...spec.args] : [WORKSPACE_DIRECT_AGENT_LAUNCH, ...helper, 'agent'])];
    const credentialPath = returning.length ? returning.map(storePath).join(', ') : undefined;
    add(RUN + '/input', JSON.stringify({ command, transportEnv, owned, backupTmpfs, credentialPath, bootTimeout: config.bootTimeout, credentialRetention: config.credentialRetention, timeout: options.timeout ?? 300_000, directories: [...directories], extensions: extensionStaged.skills, secrets }));
    add(RUN + '/stdin', options.stdinData ?? '');
    const name = 'propr-' + randomUUID();
    const launch: MachineLaunch = { name, skip_service_registration: true, skip_secrets: true, region: config.region, config: {
        image: config.image, guest: config.guest, metadata: { propr_run_id: name }, auto_destroy: true, restart: { policy: 'no' },
        processes: [{ user: 'root', ignore_app_secrets: true, entrypoint: ['/usr/bin/setpriv', '--no-new-privs', ...helper], cmd: ['launch'] }], files,
    } };
    const serialized = JSON.stringify(launch);
    if (serialized.includes(config.token)) throw new Error('Fly API credential found in Machine configuration');
    assertMachineConfigSize(Buffer.byteLength(serialized), extension);
    return { launch, credentialPath, secrets: [...new Set([config.token, ...secrets].filter(Boolean))], packageServers: extensionStaged.packageServers,
        markerArgs: transportEnv.PROPR_REPO_SETUP === '0' || !setup ? [] : [setup.script],
        /** Have the Machine install the instance runtime packages as root before the agent starts (none: no apt step at all). */
        installPackages(packages: readonly string[]) {
            if (packages.length === 0) return;
            add(RUN + '/packages.json', JSON.stringify(flyPackageInstallSpec(packages)));
        },
        async commit(api: MachinesApi, id: string) {
            if (!bundle.stores.length) return;
            const returned: ReturnedCredentialFile[] = [];
            for (const store of returning) {
                for (const relative of store.outputs) {
                    const exported = await exportMachineFile(api, id, path.join(storePath(store), relative));
                    if (exported === 'failed') throw new Error('Unable to export Fly Machine credentials');
                    if (exported) returned.push({ storeId: store.id, path: relative, ...exported });
                }
            }
            await broker.commit(bundle, returned);
        },
        /** Copy the run's runtime home results (Vibe's usage export) back to the worker; best effort, the run's outcome does not depend on it. */
        async collectRuntimeFiles(api: MachinesApi, id: string) {
            for (const home of runtimeHomes) {
                for (const relative of home.returnFiles) {
                    try {
                        const exported = await exportMachineFile(api, id, path.posix.join(home.target, relative));
                        if (exported === 'failed') throw new Error('export failed');
                        if (exported) writeReturnedRuntimeFile(home, relative, exported.content);
                    } catch (error) {
                        logger.warn({ run: spec.name, file: path.posix.join(home.target, relative), err: error }, 'Could not collect a Fly run file');
                    }
                }
            }
        } };
}

/** A file read by the node user in the Machine without following links (see the wrapper's export), or null when absent. */
async function exportMachineFile(api: MachinesApi, id: string, file: string): Promise<{ mtimeMs: number; content: Buffer } | null | 'failed'> {
    const res = await api.exec(id, ['su-exec', 'node', ...helper, 'export', file]);
    if (res.exit_code !== 0) return 'failed';
    const exported = JSON.parse(res.stdout);
    if (exported === null) return null;
    const [mtimeMs, encoded] = exported;
    const content = Buffer.from(encoded, 'base64');
    if (!Number.isFinite(mtimeMs) || content.length > MAX_RETURNED_CREDENTIAL_BYTES || content.toString('base64') !== encoded) throw new Error('Invalid Fly credential export');
    return { mtimeMs, content };
}
