import fs from 'node:fs';
import path from 'node:path';
import { WORKSPACE_DIRECT_AGENT_LAUNCH, WORKSPACE_TRANSPORT_ENVIRONMENT } from '../../../git/workspaceTransportScript.js';
import { CredentialBroker, type CredentialBundle } from '../../credentials/broker.js';
import { credentialRunRoot, envFileValues } from '../../credentials/hostCredentialStaging.js';
import type { AgentConfig, AgentType } from '../../types.js';
import { AGENT_DEFAULT_VERSIONS } from '../../version/types.js';
import { renderAgentRunEntrypoint } from '../dockerRunArgs.js';
import type { AgentRunMount, AgentRunSpec } from '../types.js';
import { SPRITES_TOKEN_VARIABLES } from './spritesConfig.js';
import { SPRITES_BIN_DIR, SPRITES_ENTRYPOINT_DIR, SPRITES_RUN_DIR, type SpritesCliPins } from './spritesSetup.js';
import { createTarArchive, type TarEntry } from './spritesTar.js';

/**
 * How an {@link AgentRunSpec} becomes one run on a Sprite: the command the
 * launcher starts, its environment, and the payload (credentials, read-only
 * files, prompt) uploaded as a single archive.
 */

/** Providers whose CLI the setup script pins. */
export const SPRITES_SUPPORTED_AGENTS: ReadonlySet<AgentType> = new Set<AgentType>(['claude', 'codex', 'antigravity']);
export const SPRITES_PAYLOAD = `${SPRITES_RUN_DIR}/payload.tar`;
/** Root-owned, written by the launcher after the run: refreshed credentials. */
export const SPRITES_EXPORT_DIR = `${SPRITES_RUN_DIR}/out`;
/** Root-owned, written by the clone wrapper: the workspace result status and bundle fallback. */
export const SPRITES_RESULT_DIR = `${SPRITES_RUN_DIR}/result`;
const AGENT_HOME = '/home/node';
/** Antigravity task runs keep their state in a disposable HOME the entrypoint fills from the read-only source. */
const ANTIGRAVITY_RUNTIME_CONFIG = '/tmp/propr-antigravity-home/.gemini';
/**
 * The PATH of everything that runs as root (the launcher's command, the clone
 * and setup wrappers): root-owned directories only. The agent user gets its
 * own PATH from the `<agent>-as-agent` shim.
 */
const ROOT_PATH = `${SPRITES_BIN_DIR}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
/** Read-only files copied into the run (e.g. Claude's `.claude.json` seed). */
export const MAX_SPRITES_UPLOAD_BYTES = 1024 * 1024;
/**
 * Variables a Sprite run never receives: the transcript path is a worker path
 * no Sprite file reaches (as in Docker's clone mode, the transcript is not returned).
 */
const WITHHELD_VARIABLES: readonly string[] = ['PROPR_ANTIGRAVITY_TRANSCRIPT_PATH'];

type BindMount = Extract<AgentRunMount, { type: 'bind' }>;

function isSafeTarget(target: string): boolean {
    if (!path.posix.isAbsolute(target) || path.posix.normalize(target) !== target || target.includes('\0')) return false;
    return target.startsWith(`${AGENT_HOME}/`) || target.startsWith('/tmp/') || target.startsWith('/run/propr-');
}

function isEmptyDirectoryMount(mount: BindMount): boolean {
    return !mount.readOnly && (mount.purpose === 'logs' || mount.purpose === 'scratch');
}

/** Why the Sprites runtime cannot provide `mount`, or undefined when it can. */
export function spritesMountRefusal(mount: BindMount): string | undefined {
    if (!isSafeTarget(mount.target)) return `cannot provide a mount at ${mount.target} (Sprite targets must be under ${AGENT_HOME}/, /tmp/ or /run/propr-)`;
    if (mount.credentialStore) {
        // A Sprite is restored to its clean checkpoint after every run, so provider state kept in the store between launches would be gone.
        return mount.credentialStore.perRun ? undefined
            : `cannot keep the ${mount.credentialStore.provider} ${mount.credentialStore.store} store at ${mount.target} between runs, which this run needs (sessions resumed by id); use the Docker runtime`;
    }
    if (mount.purpose === 'workspace' || mount.purpose === 'git') return 'cannot bind-mount the worker worktree; use the clone workspace transport';
    if (isEmptyDirectoryMount(mount)) return undefined;
    if (mount.readOnly) {
        try {
            const stat = fs.lstatSync(mount.source);
            if (stat.isFile() && stat.size <= MAX_SPRITES_UPLOAD_BYTES) return undefined;
        } catch (error) {
            // Docker creates an empty directory for a missing `-v` source; a strict (`--mount`) bind fails there too.
            if ((error as NodeJS.ErrnoException).code === 'ENOENT' && mount.syntax !== 'mount') return undefined;
        }
        return `can only copy read-only regular files up to ${MAX_SPRITES_UPLOAD_BYTES} bytes into a Sprite, not ${mount.source}`;
    }
    return `cannot share the host directory ${mount.source} read-write with a Sprite`;
}

/**
 * Where a credential store goes on the Sprite and where the CLI's refreshed
 * token is afterwards. A store the entrypoint only copies from (Antigravity's
 * source, any read-only bind) is installed read-only for the agent user.
 */
function credentialPlacement(mount: BindMount, environment: ReadonlyMap<string, string>): { kind: 'store' | 'source'; liveRoot: string } {
    const antigravitySource = mount.credentialStore?.provider === 'antigravity'
        && environment.get('PROPR_EPHEMERAL_STATE') === '1' && environment.get('PROPR_ANTIGRAVITY_SOURCE_CONFIG') === mount.target;
    if (antigravitySource) return { kind: 'source', liveRoot: ANTIGRAVITY_RUNTIME_CONFIG };
    return { kind: mount.readOnly ? 'source' : 'store', liveRoot: mount.target };
}

/**
 * The command the launcher starts as root: the clone wrapper, then the setup
 * wrapper, then the provider entrypoint behind its `<agent>-as-agent` shim,
 * which drops to the agent user before the entrypoint runs. No provider
 * entrypoint is ever started as root on a Sprite.
 */
export function renderSpritesArgv(spec: AgentRunSpec): string[] {
    const agent = spec.profile.agentType;
    if (!SPRITES_SUPPORTED_AGENTS.has(agent)) {
        throw new Error(`Agent runtime "sprites" does not run ${agent} agents; supported: ${[...SPRITES_SUPPORTED_AGENTS].join(', ')}`);
    }
    if (spec.workspace.mode !== 'clone') throw new Error(`Agent runtime "sprites" runs only the clone workspace transport (run ${spec.name})`);
    const { entrypoint, wrapperArgs } = renderAgentRunEntrypoint(spec);
    const imageEntrypoint = `${AGENT_HOME}/${agent}-entrypoint.sh`;
    const last = wrapperArgs.length - 1;
    const launch = [...wrapperArgs];
    if (spec.repoSetup) {
        if (launch[last] !== imageEntrypoint) {
            throw new Error(`Agent runtime "sprites" will not start ${launch[last]} as root for ${spec.name}: only the ${agent} entrypoint, behind its privilege-dropping shim, is run`);
        }
        launch[last] = `${SPRITES_ENTRYPOINT_DIR}/${agent}-as-agent`;
    } else if (launch[last - 1] === WORKSPACE_DIRECT_AGENT_LAUNCH && launch[last] === imageEntrypoint) {
        // Started as the agent user by the clone wrapper itself.
        launch[last] = `${SPRITES_ENTRYPOINT_DIR}/${agent}-entrypoint.sh`;
    }
    return [entrypoint ?? '/bin/bash', ...launch, ...spec.args];
}

/**
 * The run's environment with Docker's precedence: the image's base, then env
 * files in order, then `-e` variables (the repository setup's first); a
 * name-only variable takes its value from the launch environment and is
 * dropped when unset there. The Sprites org token is removed whatever named
 * it: by variable name, and any variable whose value contains it.
 */
export function resolveSpritesEnvironment(
    spec: AgentRunSpec, launchEnvironment: Record<string, string | undefined>, orgToken: string,
): { environment: Map<string, string>; withheld: string[] } {
    const environment = new Map<string, string>([
        ['PATH', ROOT_PATH], ['HOME', '/root'], ['USER', 'root'], ['LOGNAME', 'root'], ['LANG', 'C.UTF-8'],
        ['NODE_OPTIONS', '--max-old-space-size=8192'], ['AGY_CLI_DISABLE_AUTO_UPDATE', 'true'], ['DISABLE_AUTOUPDATER', '1'],
    ]);
    for (const file of [...spec.envFiles].sort((left, right) => left.order - right.order)) {
        for (const [name, value] of envFileValues(file.path, launchEnvironment)) environment.set(name, value);
    }
    for (const variable of [...(spec.repoSetup?.env ?? []), ...[...spec.env].sort((left, right) => left.order - right.order)]) {
        const value = variable.value ?? launchEnvironment[variable.name];
        if (value === undefined) environment.delete(variable.name);
        else environment.set(variable.name, value);
    }
    for (const name of WITHHELD_VARIABLES) environment.delete(name);
    const withheld = withholdOrgToken(environment, orgToken);
    for (const [name, value] of environment) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Agent run ${spec.name} has an invalid environment variable name: ${name}`);
        if (value.includes('\0')) throw new Error(`Agent run ${spec.name} has a NUL byte in environment variable ${name}`);
    }
    // The clone wrapper writes its result where the launcher made a root-owned directory for it.
    if (environment.has(WORKSPACE_TRANSPORT_ENVIRONMENT.resultDir)) environment.set(WORKSPACE_TRANSPORT_ENVIRONMENT.resultDir, SPRITES_RESULT_DIR);
    return { environment, withheld };
}

/** Removes every variable that names or carries the org token; returns the names removed. */
export function withholdOrgToken(environment: Map<string, string>, orgToken: string): string[] {
    const withheld: string[] = [];
    for (const [name, value] of environment) {
        if (SPRITES_TOKEN_VARIABLES.includes(name) || (orgToken && value.includes(orgToken))) {
            environment.delete(name);
            withheld.push(name);
        }
    }
    return withheld;
}

/** NUL-separated records, as the launcher reads them with `mapfile -d ''`. */
function nulList(values: readonly string[]): Buffer {
    for (const value of values) if (value.includes('\0')) throw new Error('Sprites launcher values cannot contain NUL bytes');
    return Buffer.from(values.map(value => `${value}\0`).join(''), 'utf8');
}

export interface SpritesRunPlan {
    argv: string[];
    environment: Map<string, string>;
    /** Variables removed because they named or carried the org token. */
    withheld: string[];
    credentialMounts: BindMount[];
    files: Array<{ source: string; target: string }>;
    directories: string[];
}

/** Validates the spec and decides what the Sprite gets. Reads no credential yet. */
export function planSpritesRun(spec: AgentRunSpec, launchEnvironment: Record<string, string | undefined>, orgToken: string): SpritesRunPlan {
    const argv = renderSpritesArgv(spec);
    const { environment, withheld } = resolveSpritesEnvironment(spec, launchEnvironment, orgToken);
    const plan: SpritesRunPlan = { argv, environment, withheld, credentialMounts: [], files: [], directories: [] };
    for (const mount of [...spec.mounts].sort((left, right) => left.order - right.order)) {
        if (mount.type === 'tmpfs') {
            if (!isSafeTarget(mount.target)) throw new Error(`Agent runtime "sprites" cannot provide a tmpfs at ${mount.target} for ${spec.name}`);
            plan.directories.push(mount.target);
            continue;
        }
        const refusal = spritesMountRefusal(mount);
        if (refusal) throw new Error(`Agent runtime "sprites" ${refusal} for ${spec.name}`);
        if (mount.credentialStore) plan.credentialMounts.push(mount);
        else if (isEmptyDirectoryMount(mount)) plan.directories.push(mount.target);
        else if (fs.existsSync(mount.source)) plan.files.push({ source: mount.source, target: mount.target });
    }
    return plan;
}

export interface SpritesRunCredentials {
    broker: CredentialBroker;
    bundle: CredentialBundle;
    /** Refreshable files the launcher exports, by export index. */
    outputs: Array<{ storeId: string; path: string; livePath: string }>;
}

/**
 * The per-run credential copy, read from the canonical stores now (the run
 * holds its Sprite, so the copy is as fresh as it can be). Its secret
 * variables join the run's environment unless the run defines them.
 */
export function materializeSpritesCredentials(
    plan: SpritesRunPlan, options: { environment?: Record<string, string | undefined>; broker?: CredentialBroker; orgToken: string },
): SpritesRunCredentials | undefined {
    if (plan.credentialMounts.length === 0) return undefined;
    const broker = options.broker ?? new CredentialBroker({ lock: { lockRoot: path.join(credentialRunRoot(options.environment ?? process.env), '.locks') } });
    const bundle = broker.materialize(plan.credentialMounts.map(mount => ({
        id: `${mount.credentialStore!.provider}-${mount.credentialStore!.store}`,
        provider: mount.credentialStore!.provider,
        store: mount.credentialStore!.store,
        canonicalRoot: mount.source,
    })), { definedEnv: [...plan.environment].filter(([, value]) => value !== '').map(([name]) => name) });
    for (const [name, value] of Object.entries(bundle.secretEnv)) {
        if (!plan.environment.has(name)) plan.environment.set(name, value);
    }
    plan.withheld.push(...withholdOrgToken(plan.environment, options.orgToken));
    const outputs: SpritesRunCredentials['outputs'] = [];
    bundle.stores.forEach((store, index) => {
        const { liveRoot } = credentialPlacement(plan.credentialMounts[index], plan.environment);
        for (const output of store.outputs) outputs.push({ storeId: store.id, path: output, livePath: path.posix.join(liveRoot, output) });
    });
    return { broker, bundle, outputs };
}

function addDirectories(entries: Map<string, TarEntry>, directory: string): void {
    const parts = directory.split('/');
    for (let depth = 1; depth <= parts.length; depth++) {
        const current = parts.slice(0, depth).join('/');
        if (!entries.has(current)) entries.set(current, { path: current, type: 'directory', mode: 0o700 });
    }
}

/**
 * The single archive a run uploads: the command, environment and prompt, the
 * credential stores, the read-only files, and the manifest telling the
 * launcher where each goes. Manifest records: `store|source <payload dir>
 * <target>`, `file <payload file> <target>`, `dir <target>`, `output <index>
 * <live path>`.
 */
export function buildSpritesPayload(plan: SpritesRunPlan, run: { credentials?: SpritesRunCredentials; stdinData?: string; stdin: boolean }): Buffer {
    const entries = new Map<string, TarEntry>();
    const records: string[] = [];
    const addFile = (entryPath: string, content: Buffer, mode = 0o600, mtimeMs?: number): void => {
        const parent = path.posix.dirname(entryPath);
        if (parent !== '.') addDirectories(entries, parent);
        entries.set(entryPath, { path: entryPath, type: 'file', content, mode, ...(mtimeMs === undefined ? {} : { mtimeMs }) });
    };
    run.credentials?.bundle.stores.forEach((store, index) => {
        const mount = plan.credentialMounts[index];
        const root = `store/${index}`;
        addDirectories(entries, root);
        for (const directory of store.directories) addDirectories(entries, `${root}/${directory}`);
        for (const file of store.files) addFile(`${root}/${file.path}`, file.content, file.mode, file.mtimeMs);
        records.push(credentialPlacement(mount, plan.environment).kind, root, mount.target);
    });
    plan.files.forEach((file, index) => {
        const stat = fs.lstatSync(file.source);
        if (!stat.isFile() || stat.size > MAX_SPRITES_UPLOAD_BYTES) throw new Error(`Agent runtime "sprites" can only copy read-only regular files up to ${MAX_SPRITES_UPLOAD_BYTES} bytes, not ${file.source}`);
        addFile(`files/${index}`, fs.readFileSync(file.source));
        records.push('file', `files/${index}`, file.target);
    });
    for (const directory of plan.directories) records.push('dir', directory);
    (run.credentials?.outputs ?? []).forEach((output, index) => records.push('output', String(index), output.livePath));
    addFile('argv', nulList(plan.argv));
    addFile('env', nulList([...plan.environment].map(([name, value]) => `${name}=${value}`)));
    addFile('manifest', nulList(records));
    if (run.stdin) addFile('stdin', Buffer.from(run.stdinData ?? '', 'utf8'));
    return createTarArchive([...entries.values()]);
}

/** What a launch knows of the agent's CLI version selection. */
export type SpritesCliVersionSelection = Partial<Pick<AgentConfig, 'type' | 'id' | 'alias' | 'cliVersionType' | 'cliVersion' | 'cliVersionResolved'>>;

/**
 * Why the Sprites runtime cannot run the agent's selected CLI version, or
 * undefined when it runs exactly that version. A Sprite runs the one version
 * its setup pins (`Dockerfile.agent`'s), so any other selection is refused
 * rather than silently run on the pinned version.
 */
export function spritesCliVersionRefusal(agent: SpritesCliVersionSelection & { type: AgentType }, pins: SpritesCliPins): string | undefined {
    const provided = agent.type === 'claude' ? pins.CLAUDE_CLI_VERSION : agent.type === 'codex' ? pins.CODEX_CLI_VERSION
        : agent.type === 'antigravity' ? pins.ANTIGRAVITY_CLI_VERSION : undefined;
    if (!provided) return undefined;
    const requested = agent.cliVersionType !== undefined && agent.cliVersionType !== 'default';
    const selected = agent.cliVersionResolved?.trim()
        || (requested ? (agent.cliVersionType === 'specific' ? agent.cliVersion?.trim() : undefined) : AGENT_DEFAULT_VERSIONS[agent.type]);
    if (selected === provided) return undefined;
    const selection = selected ?? `${agent.cliVersionType} ${agent.cliVersion ?? ''}`.trim();
    return `agent '${agent.alias || agent.id || agent.type}' selects ${agent.type} CLI ${selection}, but a Sprite runs only ${agent.type} CLI ${provided} (the version Dockerfile.agent pins). Use the default CLI version on Sprites, or the Docker runtime for other versions`;
}
