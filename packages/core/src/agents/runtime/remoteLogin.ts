import type { AgentType } from '../types.js';

/**
 * An interactive provider login (`claude auth login`, `codex login
 * --device-auth`, …) run on a remote agent runtime instead of a local Docker
 * container. The caller streams the terminal output to the browser, forwards
 * keystrokes, then copies the login files the provider manifest declares
 * back into the agent's credential store before closing the session, which
 * destroys the Sprite or Machine. A login runtime is never reused for a run.
 */

/** Home of the agent user on every remote runtime (and in the agent image). */
export const REMOTE_LOGIN_HOME = '/home/node';

export interface RemoteLoginRequest {
    agentType: AgentType;
    /** The provider CLI's login argv, run as the agent user with HOME=/home/node. */
    command: readonly string[];
    environment?: Readonly<Record<string, string>>;
    /** Absolute directories (under /home/node) the CLI writes its login to; created for the agent user before it starts. */
    directories: readonly string[];
    signal: AbortSignal;
    /** Status lines for the terminal while the runtime is prepared ("Waiting for a Sprite", …). */
    onProgress?: (message: string) => void;
}

export interface RemoteLoginProcess {
    /** Human-readable location, e.g. "Sprite propr-…" or "Fly Machine 1234 in app agents". */
    readonly location: string;
    /** Terminal output, in arrival order. Registered once by the session. */
    onOutput(listener: (chunk: string) => void): void;
    write(input: string): Promise<void>;
    /** Resolves with the CLI's exit code once it has exited; rejects when the runtime connection is lost. */
    readonly exited: Promise<number>;
    /** Stop the CLI (cancel, timeout). The runtime still has to be closed. */
    kill(): void;
    /** A regular file the login wrote, or undefined when it does not exist. */
    readFile(absolutePath: string): Promise<Buffer | undefined>;
    /** Destroy the Sprite or Machine. Idempotent. */
    close(): Promise<void>;
}

/** No Sprite or Machine slot is free for the login within the wait; the message names the cap. */
export class RemoteLoginCapacityError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RemoteLoginCapacityError';
    }
}

/** How long a login waits for a Sprite or Machine slot before it fails with the cap in the message. */
export const REMOTE_LOGIN_SLOT_WAIT_MS = 30_000;

/** Only absolute paths under the agent home, without traversal, are read from or created on the runtime. */
export function assertRemoteLoginPath(value: string): string {
    if (!value.startsWith(REMOTE_LOGIN_HOME + '/') || /[\0\r\n]/.test(value)
        || value.split('/').some(part => part === '..' || part === '.')) {
        throw new Error(`Invalid remote login path: ${value}`);
    }
    return value;
}

/** POSIX single-quoting for a shell word. */
export const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** `env` assignments for the login CLI: a fixed agent-user baseline plus the provider's login environment. */
export function remoteLoginEnvironment(request: Pick<RemoteLoginRequest, 'environment'>, path: string): string[] {
    const fixed: Record<string, string> = {
        HOME: REMOTE_LOGIN_HOME, USER: 'node', LOGNAME: 'node', PATH: path, TERM: 'xterm-256color', LANG: 'C.UTF-8',
    };
    const entries = Object.entries({ ...request.environment, ...fixed });
    for (const [name] of entries) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid login environment variable ${name}`);
    }
    return entries.map(([name, value]) => `${name}=${value}`);
}

/** Parses the `F:<base64>` / `M` reply of the file read helpers. */
export function parseRemoteFileReply(stdout: string): Buffer | undefined {
    const reply = stdout.trim();
    if (reply === 'M') return undefined;
    if (!reply.startsWith('F:')) throw new Error('Invalid remote login file reply');
    const encoded = reply.slice(2);
    const content = Buffer.from(encoded, 'base64');
    if (content.toString('base64') !== encoded) throw new Error('Invalid remote login file encoding');
    return content;
}

/** Shell that prints `F:<base64>` for a regular, non-symlink file and `M` otherwise. `$1` is the path. */
export const REMOTE_FILE_READ_SCRIPT = 'if [ -f "$1" ] && [ ! -L "$1" ]; then printf "F:"; base64 -w0 "$1"; else printf M; fi';
