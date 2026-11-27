import fs from 'node:fs';
import path from 'node:path';
import { readRegularFileInside } from '../credentials/broker.js';
import type { CredentialStoreKind } from '../credentials/providerManifests.js';
import { VIBE_CONTAINER_RUNTIME_HOME, VIBE_EXPORT_DIR_NAME } from '../impl/utils/vibeExportUsage.js';
import type { AgentType } from '../types.js';
import type { AgentRunMount } from './types.js';

/**
 * How runtimes without bind mounts (Fly Machines, Sprites) provide the binds
 * a provider's run spec carries. The agent configuration's credential stores
 * travel as per-run copies of their manifest files (see the credential broker),
 * a prompt file travels as a file of the run, and a runtime home is a fresh
 * directory in the sandbox whose result files are copied back to the worker.
 */

type Bind = Extract<AgentRunMount, { type: 'bind' }>;

/** The agent types Fly Machines and Sprites both run (Sprites also runs Antigravity). */
export const REMOTE_AGENT_TYPES = Object.freeze(['claude', 'codex', 'vibe', 'opencode'] as const);
export type RemoteAgentType = typeof REMOTE_AGENT_TYPES[number];
export const isRemoteAgentType = (type: string): type is RemoteAgentType => (REMOTE_AGENT_TYPES as readonly string[]).includes(type);

/** Where each provider's run spec binds its credential stores: the paths its entrypoint reads them from. */
const STORE_TARGETS: Readonly<Record<RemoteAgentType, Partial<Record<CredentialStoreKind, string>>>> = Object.freeze({
    claude: { config: '/home/node/.claude' },
    codex: { config: '/home/node/.codex' },
    vibe: { config: '/home/node/.vibe' },
    // The entrypoint copies the data store's logins into the run's disposable XDG data directory and syncs them back.
    opencode: { config: '/home/node/.config/opencode', data: '/home/node/.local/share/opencode-source' },
});

/** The sandbox path of `provider`'s `store`, or undefined when its run spec has no such store. */
export function remoteCredentialStoreTarget(provider: AgentType, store: CredentialStoreKind): string | undefined {
    return isRemoteAgentType(provider) ? STORE_TARGETS[provider][store] : undefined;
}

/** A per-run credential store bind at the path its provider reads it from. */
export function isRemoteCredentialStoreMount(mount: Bind): boolean {
    const store = mount.credentialStore;
    return !!store?.perRun && mount.purpose === (store.store === 'data' ? 'data' : 'credential')
        && remoteCredentialStoreTarget(store.provider, store.store) === mount.target;
}

/** Prompt files are uploaded with the run; bounded so they fit one Machine create request. */
export const MAX_REMOTE_PROMPT_BYTES = 2 * 1024 * 1024;
const PROMPT_TARGET = /^\/(?:home\/node|tmp)\/[\w.-]+$/;

/** A read-only single-file prompt bind (Vibe's `--prompt-file`) the runtime uploads to the same path. */
export function isRemotePromptMount(mount: Bind): boolean {
    return mount.purpose === 'prompt' && mount.readOnly && PROMPT_TARGET.test(mount.target) && path.posix.normalize(mount.target) === mount.target;
}

/** The prompt file's bytes, read without following a link. */
export function readRemotePromptFile(mount: Bind): Buffer {
    const read = readRegularFileInside(path.dirname(mount.source), path.basename(mount.source), MAX_REMOTE_PROMPT_BYTES);
    if (read === 'oversized') throw new Error(`The prompt file for ${mount.target} exceeds ${MAX_REMOTE_PROMPT_BYTES} bytes`);
    if (!read) throw new Error(`The prompt file for ${mount.target} is missing or not a regular file`);
    return read.content;
}

/**
 * A provider's per-run home: a directory created in the sandbox for the run
 * (the Docker runtime binds a host directory there instead). `returnFiles`
 * (relative) are copied back into the bind's host source after the run, for
 * the parsers that read them there.
 */
export interface RemoteRuntimeHome { target: string; source: string; returnFiles: readonly string[] }

/** Vibe 3 writes its usage export here (`--output-dir`); cost parsing reads it from the host runtime home. */
const VIBE_RETURN_FILES = Object.freeze([`${VIBE_EXPORT_DIR_NAME}/export.json`]);

export function remoteRuntimeHome(mount: Bind): RemoteRuntimeHome | undefined {
    if (mount.purpose !== 'runtime-home' || mount.readOnly || mount.target !== VIBE_CONTAINER_RUNTIME_HOME) return undefined;
    return { target: mount.target, source: mount.source, returnFiles: VIBE_RETURN_FILES };
}

/** Why the remote runtimes cannot provide `mount`, or undefined when they can (credential stores, prompts and runtime homes). */
export function unsupportedRemoteRunMount(mount: Bind): string | undefined {
    if (isRemoteCredentialStoreMount(mount) || isRemotePromptMount(mount) || remoteRuntimeHome(mount)) return undefined;
    return `cannot provide the ${mount.purpose} mount at ${mount.target}`;
}

/** Writes a file the run returned into its runtime home's host directory, never through a link. */
export function writeReturnedRuntimeFile(home: RemoteRuntimeHome, relative: string, content: Buffer): void {
    if (!home.returnFiles.includes(relative)) throw new Error(`Unexpected runtime file ${relative}`);
    const target = path.join(home.source, relative);
    const parent = path.dirname(target);
    fs.mkdirSync(parent, { recursive: true });
    for (let current = parent; current.startsWith(home.source) && current !== home.source; current = path.dirname(current)) {
        if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Refusing to write ${relative} through a link`);
    }
    const temporary = `${target}.propr-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temporary, content, { mode: 0o644, flag: 'wx' });
    fs.renameSync(temporary, target);
}
