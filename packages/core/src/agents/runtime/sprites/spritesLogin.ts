import type { Sprite } from '@fly/sprites';
import logger from '../../../utils/logger.js';
import {
    assertRemoteLoginPath, parseRemoteFileReply, REMOTE_FILE_READ_SCRIPT, REMOTE_LOGIN_HOME, REMOTE_LOGIN_SLOT_WAIT_MS, remoteLoginEnvironment,
    RemoteLoginCapacityError, type RemoteLoginProcess, type RemoteLoginRequest,
} from '../remoteLogin.js';
import { SpritePoolCapacityError, type Slot, type SpritePool } from './spritesProvisioning.js';

/** The agent user's PATH on a provisioned Sprite (see `sprites-agent-setup.sh`). */
const SPRITE_LOGIN_PATH = `${REMOTE_LOGIN_HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin`;
const SU_EXEC = '/usr/local/bin/su-exec';

type LoginPool = Pick<SpritePool, 'acquire' | 'discard'>;

/**
 * Runs the provider login CLI with a TTY on a pooled Sprite. The Sprite is
 * taken through the pool, so it counts against `PROPR_SPRITES_MAX` like a run
 * and gets the same provisioned CLIs, and it is always deleted afterwards:
 * a Sprite that held a login is never returned to the warm pool.
 */
export async function startSpriteLogin(pool: LoginPool, request: RemoteLoginRequest,
    { slotWaitMs = REMOTE_LOGIN_SLOT_WAIT_MS }: { slotWaitMs?: number } = {}): Promise<RemoteLoginProcess> {
    const directories = request.directories.map(assertRemoteLoginPath);
    let slot: Slot;
    try {
        slot = await pool.acquire(request.signal, () => {
            request.onProgress?.(`All Sprites are in use; waiting up to ${Math.round(slotWaitMs / 1000)}s for a free one…`);
        }, undefined, { maxQueueMs: slotWaitMs });
    } catch (error) {
        if (error instanceof SpritePoolCapacityError) {
            throw new RemoteLoginCapacityError(`No Sprite is free for the login: all ${error.cap ?? ''} Sprite slots (PROPR_SPRITES_MAX) are in use. `
                + 'Wait for a running task to finish and try again, or raise PROPR_SPRITES_MAX (the Sprites Free Plan allows 3).');
        }
        throw error;
    }
    const sprite: Sprite = slot.sprite;
    let closed: Promise<void> | undefined;
    const close = () => closed ??= pool.discard(sprite).catch(error => {
        logger.warn({ sprite: sprite.name, err: error }, 'Could not delete the Sprite used for an agent login');
    });
    try {
        if (directories.length > 0) {
            await sprite.execFile('sudo', ['-n', SU_EXEC, 'node', 'mkdir', '-p', '-m', '700', ...directories], { cwd: REMOTE_LOGIN_HOME, timeout: 30_000 });
        }
        const environment = remoteLoginEnvironment(request, SPRITE_LOGIN_PATH);
        const command = sprite.spawn('sudo', ['-n', SU_EXEC, 'node', 'env', '-i', ...environment, ...request.command],
            { tty: true, cwd: REMOTE_LOGIN_HOME, cols: 120, rows: 40 });
        const listeners: Array<(chunk: string) => void> = [];
        const buffered: string[] = [];
        const emit = (chunk: string) => {
            if (listeners.length === 0) buffered.push(chunk);
            else for (const listener of listeners) listener(chunk);
        };
        command.stdout.on('data', (chunk: Buffer | string) => emit(chunk.toString()));
        command.stderr.on('data', (chunk: Buffer | string) => emit(chunk.toString()));
        const exited = new Promise<number>((resolve, reject) => {
            command.once('exit', (code: number) => resolve(code));
            command.once('error', (error: Error) => reject(error));
        });
        exited.catch(() => {});
        return {
            location: `Sprite ${sprite.name}`,
            onOutput(listener) {
                listeners.push(listener);
                for (const chunk of buffered.splice(0)) listener(chunk);
            },
            write: input => new Promise<void>((resolve, reject) => {
                command.stdin.write(input, error => error ? reject(error) : resolve());
            }),
            exited,
            kill: () => { try { command.kill(); } catch { /* already gone */ } },
            async readFile(absolutePath) {
                const file = assertRemoteLoginPath(absolutePath);
                const result = await sprite.execFile('sudo', ['-n', '/bin/sh', '-c', REMOTE_FILE_READ_SCRIPT, 'sh', file], { cwd: '/', timeout: 30_000 });
                return parseRemoteFileReply(result.stdout.toString());
            },
            close,
        };
    } catch (error) {
        await close();
        throw error;
    }
}
