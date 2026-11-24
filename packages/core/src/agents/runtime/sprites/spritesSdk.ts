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
    tty?: boolean;
    detachable?: boolean;
    sessionId?: string;
    /** How long the command may keep running after the connection drops, e.g. `24h`. */
    maxRunAfterDisconnect?: string;
}

export interface SpriteExecResult { stdout: string | Buffer; stderr: string | Buffer; exitCode: number }

export interface SpriteSessionInfo { id: string; command: string; isActive: boolean }

export interface SpriteFileStats { size: number; mtime: Date; isFile(): boolean }

export interface SpriteFilesystemLike {
    readFile(path: string, encoding?: null): Promise<Buffer>;
    writeFile(path: string, data: string | Buffer, options?: { mode?: number }): Promise<void>;
    mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
    rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
    stat(path: string): Promise<SpriteFileStats>;
}

export interface SpriteStreamMessage { type: string; data?: string; error?: string }
export interface SpriteProgressStream { [Symbol.asyncIterator](): AsyncIterator<SpriteStreamMessage> }
export interface SpriteCheckpointInfo { id: string; comment?: string; createTime?: Date }

export interface SpriteLike {
    readonly name: string;
    status?: string;
    /** A plain (non-TTY) exec: stdout and stderr arrive separately, byte for byte. */
    spawn(command: string, args?: string[], options?: SpriteSpawnOptions): SpriteCommandLike;
    /** A detachable session (the SDK opens it as a TTY); it keeps running when the connection drops. */
    createSession(command: string, args?: string[], options?: SpriteSpawnOptions): SpriteCommandLike;
    listSessions(): Promise<SpriteSessionInfo[]>;
    execFile(file: string, args?: string[], options?: { cwd?: string; timeout?: number; maxBuffer?: number; encoding?: BufferEncoding }): Promise<SpriteExecResult>;
    filesystem(workingDir?: string): SpriteFilesystemLike;
    createCheckpoint(comment?: string): Promise<SpriteProgressStream>;
    listCheckpoints(): Promise<SpriteCheckpointInfo[]>;
    restoreCheckpoint(id: string): Promise<SpriteProgressStream>;
}

export interface SpritesClientLike {
    sprite(name: string): SpriteLike;
    getSprite(name: string): Promise<SpriteLike>;
    createSprite(name: string, options?: {
        config?: { ramMB?: number; cpus?: number; region?: string };
        labels?: string[];
        waitForCapacity?: boolean;
    }): Promise<SpriteLike>;
}

export type SpritesClientFactory = (config: SpritesRuntimeConfig) => Promise<SpritesClientLike>;

/** Errors the SDK raises for an HTTP status (e.g. `APIError` with `statusCode`). */
export function spritesErrorStatus(error: unknown): number | undefined {
    const status = (error as { statusCode?: unknown; status?: unknown } | null)?.statusCode ?? (error as { status?: unknown } | null)?.status;
    if (typeof status === 'number') return status;
    const match = /\(status (\d{3})\)/.exec((error as Error | null)?.message ?? '');
    return match ? Number(match[1]) : undefined;
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
