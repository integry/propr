/**
 * Files a Fly dashboard launch (#3827) keeps on the data volume, under
 * `<DATA_DIR>/fly-launch` (mode 0700). Every file is written atomically with
 * mode 0600: a temporary file in the same directory, then a rename, so a
 * crash or idle stop mid-write never leaves a truncated secret behind.
 *
 *   secrets.json     secrets generated on first boot (bootSecrets.ts)
 *   config.json      what the setup wizard saved: plain env values and the
 *                    GitHub App it created (launchConfig.ts)
 *   github-app.pem   the GitHub App private key from the manifest flow
 *   setup.json       the one-time setup code and the claim (setupAccess.ts)
 *
 * Kept free of service imports (no @propr/core): the launch entry runs it
 * before anything opens SQLite or Redis.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const FLY_LAUNCH_DIR_NAME = 'fly-launch';
const DEFAULT_DATA_DIR = '/usr/src/app/data';

export interface LaunchStore {
    readonly dir: string;
    path(name: string): string;
    readJson<T>(name: string): T | undefined;
    writeJson(name: string, value: unknown): void;
    writeText(name: string, value: string): void;
    remove(name: string): void;
}

export function launchStoreDir(env: NodeJS.ProcessEnv): string {
    return join(env.DATA_DIR?.trim() || DEFAULT_DATA_DIR, FLY_LAUNCH_DIR_NAME);
}

export function createLaunchStore(dir: string): LaunchStore {
    const ensureDir = (): void => {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        chmodSync(dir, 0o700);
    };
    const path = (name: string): string => {
        if (!/^[a-z0-9][a-z0-9.-]*$/.test(name)) throw new Error(`Invalid launch store file name ${name}`);
        return join(dir, name);
    };
    const writeText = (name: string, value: string): void => {
        ensureDir();
        const target = path(name);
        const temporary = join(dir, `.${name}.${randomBytes(6).toString('hex')}.tmp`);
        try {
            writeFileSync(temporary, value, { mode: 0o600, flag: 'wx' });
            renameSync(temporary, target);
            chmodSync(target, 0o600);
        } finally {
            rmSync(temporary, { force: true });
        }
    };
    return {
        dir,
        path,
        readJson<T>(name: string): T | undefined {
            const target = path(name);
            if (!existsSync(target)) return undefined;
            try {
                return JSON.parse(readFileSync(target, 'utf8')) as T;
            } catch {
                // The values are never part of the message.
                throw new Error(`${target} is not valid JSON; restore it from a volume snapshot or delete it to start that step again`);
            }
        },
        writeJson(name: string, value: unknown): void {
            writeText(name, `${JSON.stringify(value, null, 2)}\n`);
        },
        writeText,
        remove(name: string): void {
            rmSync(path(name), { force: true });
        },
    };
}
