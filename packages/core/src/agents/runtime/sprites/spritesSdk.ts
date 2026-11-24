import type { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { applySpritesClientSignalsDefault, type SpritesRuntimeConfig } from './spritesConfig.js';

/**
 * The part of `@fly/sprites` the runtime uses. The SDK is loaded lazily (a
 * Docker-only worker never imports it) and unit tests substitute a fake.
 */
export interface SpriteCommandLike extends EventEmitter {
    readonly stdin: Writable;
    readonly stdout: Readable;
    readonly stderr: Readable;
    /** Exit status; `-1` when the connection closed before the command reported one. */
    wait(): Promise<number>;
    kill(signal?: string): void;
    close(): void;
}

export interface SpriteSpawnOptions {
    cwd?: string;
    env?: Record<string, string>;
    /** How long the command may keep running after the connection drops, e.g. `3600s`. */
    maxRunAfterDisconnect?: string;
}

export interface SpriteExecResult { stdout: string | Buffer; stderr: string | Buffer; exitCode: number }

/** One directory entry or `stat` result. The type is the entry's own (`lstat`): a symlink is reported as one, never followed. */
export interface SpriteFileEntry {
    size?: number;
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
}

export interface SpriteFilesystemLike {
    readFile(path: string, encoding?: null): Promise<Buffer>;
    writeFile(path: string, data: string | Buffer, options?: { mode?: number }): Promise<void>;
    mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
    stat(path: string): Promise<SpriteFileEntry>;
}

export interface SpriteStreamMessage { type: string; data?: string; error?: string }
export interface SpriteProgressStream { [Symbol.asyncIterator](): AsyncIterator<SpriteStreamMessage> }
export interface SpriteCheckpointInfo { id: string; comment?: string; createTime?: Date }

export interface SpriteLike {
    readonly name: string;
    /** Assigned by the API; a Sprite deleted and created again under the same name gets another. */
    id?: string;
    /** A plain (non-TTY) exec: stdout and stderr arrive separately, byte for byte. */
    spawn(command: string, args?: string[], options?: SpriteSpawnOptions): SpriteCommandLike;
    /** A detachable session (the SDK opens it as a TTY); it keeps running when the connection drops. */
    createSession(command: string, args?: string[], options?: SpriteSpawnOptions): SpriteCommandLike;
    execFile(file: string, args?: string[], options?: { timeout?: number; maxBuffer?: number }): Promise<SpriteExecResult>;
    filesystem(workingDir?: string): SpriteFilesystemLike;
    createCheckpoint(comment?: string): Promise<SpriteProgressStream>;
    listCheckpoints(): Promise<SpriteCheckpointInfo[]>;
    restoreCheckpoint(id: string): Promise<SpriteProgressStream>;
}

export interface SpritesClientLike {
    getSprite(name: string): Promise<SpriteLike>;
    createSprite(name: string, options?: {
        config?: { ramMB?: number; cpus?: number; region?: string };
        labels?: string[];
        waitForCapacity?: boolean;
    }): Promise<SpriteLike>;
    deleteSprite(name: string): Promise<void>;
}

export type SpritesClientFactory = (config: SpritesRuntimeConfig) => Promise<SpritesClientLike>;

/** Errors the SDK raises for an HTTP status (e.g. `APIError` with `statusCode`). */
export function spritesErrorStatus(error: unknown): number | undefined {
    const status = (error as { statusCode?: unknown; status?: unknown } | null)?.statusCode ?? (error as { status?: unknown } | null)?.status;
    if (typeof status === 'number') return status;
    const match = /\(status (\d{3})\)/.exec((error as Error | null)?.message ?? '');
    return match ? Number(match[1]) : undefined;
}

export function isMissingSpriteFile(error: unknown): boolean {
    return (error as { code?: unknown } | null)?.code === 'ENOENT' || /not found|no such file/i.test((error as Error | null)?.message ?? '');
}

function text(value: string | Buffer | undefined): string {
    return Buffer.isBuffer(value) ? value.toString('utf8') : value ?? '';
}

/**
 * Runs a command to completion and resolves with its exit status either way
 * (the SDK rejects with an `ExecError` carrying the result when it is not 0).
 * Rejects only when the command could not be run or did not report a status.
 */
export async function execOnSprite(
    sprite: SpriteLike, file: string, args: string[], options: { timeout: number; maxBuffer?: number },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    try {
        const result = await sprite.execFile(file, args, options);
        return { exitCode: result.exitCode, stdout: text(result.stdout), stderr: text(result.stderr) };
    } catch (error) {
        const failure = error as { exitCode?: unknown; stdout?: string | Buffer; stderr?: string | Buffer };
        if (typeof failure.exitCode === 'number') return { exitCode: failure.exitCode, stdout: text(failure.stdout), stderr: text(failure.stderr) };
        throw error;
    }
}

/** Reads a progress stream to its end; an `error` message fails it. */
export async function drainSpriteStream(stream: SpriteProgressStream, what: string): Promise<void> {
    for await (const message of stream) {
        if (message.type === 'error') throw new Error(`${what} failed: ${message.error ?? message.data ?? 'unknown error'}`);
    }
}

export const defaultSpritesClientFactory: SpritesClientFactory = async config => {
    applySpritesClientSignalsDefault();
    let sdk: typeof import('@fly/sprites');
    try {
        sdk = await import('@fly/sprites');
    } catch (error) {
        throw new Error(`The Sprites agent runtime needs the @fly/sprites package: ${(error as Error).message}`);
    }
    return new sdk.SpritesClient(config.token, config.baseURL ? { baseURL: config.baseURL } : {}) as unknown as SpritesClientLike;
};
