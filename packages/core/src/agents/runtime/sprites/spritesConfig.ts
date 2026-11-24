import { createHash } from 'node:crypto';
import os from 'node:os';

/**
 * Operator settings of the Sprites runtime (`PROPR_AGENT_RUNTIME=sprites`, or
 * an agent's `runtime: sprites`). Everything is read from the worker
 * environment when a run starts, so a changed secret applies to the next run.
 */
export const SPRITES_TOKEN_ENV = 'PROPR_SPRITES_TOKEN';
/** Accepted as a fallback, under the name the Sprites CLI and SDK examples use. */
export const SPRITES_TOKEN_FALLBACK_ENV = 'SPRITES_TOKEN';
export const SPRITES_NAME_PREFIX_ENV = 'PROPR_SPRITES_NAME_PREFIX';
export const SPRITES_REGION_ENV = 'PROPR_SPRITES_REGION';
export const SPRITES_API_URL_ENV = 'PROPR_SPRITES_API_URL';
export const SPRITES_RAM_MB_ENV = 'PROPR_SPRITES_RAM_MB';
export const SPRITES_CPUS_ENV = 'PROPR_SPRITES_CPUS';
export const SPRITES_MAX_SPRITES_ENV = 'PROPR_SPRITES_MAX_SPRITES';
export const SPRITES_RESTORE_ENV = 'PROPR_SPRITES_RESTORE_CHECKPOINT';
export const SPRITES_KEEP_AWAKE_INTERVAL_ENV = 'PROPR_SPRITES_KEEP_AWAKE_INTERVAL_MS';
export const SPRITES_WORKER_ID_ENV = 'PROPR_SPRITES_WORKER_ID';
/** The SDK's own switch for its usage-attribution headers; ProPR turns them off unless the operator set it. */
export const SPRITES_CLIENT_SIGNALS_ENV = 'SPRITES_CLIENT_SIGNALS';

export const DEFAULT_SPRITES_NAME_PREFIX = 'propr';
export const DEFAULT_SPRITES_MAX_SPRITES = 4;
export const DEFAULT_SPRITES_KEEP_AWAKE_INTERVAL_MS = 30_000;
/** Sprite names: lowercase letters, digits and hyphens, starting with a letter. */
const SPRITE_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const MAX_SPRITE_NAME_LENGTH = 63;

export interface SpritesRuntimeConfig {
    /** Org-scoped Sprites API token (secret: never logged, never sent to a run). */
    token: string;
    namePrefix: string;
    region?: string;
    baseURL?: string;
    ramMB?: number;
    cpus?: number;
    /** Sprites this worker runs at once; one run per Sprite. */
    maxSprites: number;
    /** Restore the Sprite's clean post-setup checkpoint before every run. */
    restoreCheckpoint: boolean;
    keepAwakeIntervalMs: number;
    /** Stable per worker, so a restarted worker finds (and reattaches to) its own Sprites. */
    workerId: string;
}

export class SpritesConfigurationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SpritesConfigurationError';
    }
}

type Environment = Record<string, string | undefined>;

function positiveInteger(environment: Environment, name: string, fallback?: number): number | undefined {
    const raw = environment[name]?.trim();
    if (!raw) return fallback;
    if (!/^\d+$/.test(raw) || Number(raw) <= 0 || !Number.isSafeInteger(Number(raw))) {
        throw new SpritesConfigurationError(`${name} must be a positive integer, not "${raw}"`);
    }
    return Number(raw);
}

function flag(environment: Environment, name: string, fallback: boolean): boolean {
    const raw = environment[name]?.trim().toLowerCase();
    if (!raw) return fallback;
    if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
    if (['0', 'false', 'no', 'off'].includes(raw)) return false;
    throw new SpritesConfigurationError(`${name} must be true or false, not "${raw}"`);
}

/** A short, stable identity for this worker: explicit, else the Fly Machine, else the host name. */
function defaultWorkerId(environment: Environment): string {
    const source = environment.FLY_MACHINE_ID?.trim() || os.hostname();
    return createHash('sha256').update(source).digest('hex').slice(0, 8);
}

export function resolveSpritesRuntimeConfig(environment: Environment = process.env): SpritesRuntimeConfig {
    const token = environment[SPRITES_TOKEN_ENV]?.trim() || environment[SPRITES_TOKEN_FALLBACK_ENV]?.trim();
    if (!token) {
        throw new SpritesConfigurationError(`The Sprites agent runtime needs an org-scoped Sprites token in ${SPRITES_TOKEN_ENV}`);
    }
    const namePrefix = (environment[SPRITES_NAME_PREFIX_ENV]?.trim() || DEFAULT_SPRITES_NAME_PREFIX).toLowerCase();
    if (!SPRITE_NAME_PATTERN.test(namePrefix) || namePrefix.length > 24) {
        throw new SpritesConfigurationError(`${SPRITES_NAME_PREFIX_ENV} must be 1-24 lowercase letters, digits or hyphens starting with a letter, not "${namePrefix}"`);
    }
    const workerId = (environment[SPRITES_WORKER_ID_ENV]?.trim() || defaultWorkerId(environment)).toLowerCase();
    if (!/^[a-z0-9-]{1,16}$/.test(workerId)) {
        throw new SpritesConfigurationError(`${SPRITES_WORKER_ID_ENV} must be 1-16 lowercase letters, digits or hyphens, not "${workerId}"`);
    }
    const region = environment[SPRITES_REGION_ENV]?.trim() || undefined;
    if (region && !/^[a-z0-9-]{2,16}$/.test(region)) throw new SpritesConfigurationError(`${SPRITES_REGION_ENV} is not a region code: "${region}"`);
    return {
        token,
        namePrefix,
        region,
        baseURL: environment[SPRITES_API_URL_ENV]?.trim() || undefined,
        ramMB: positiveInteger(environment, SPRITES_RAM_MB_ENV),
        cpus: positiveInteger(environment, SPRITES_CPUS_ENV),
        maxSprites: positiveInteger(environment, SPRITES_MAX_SPRITES_ENV, DEFAULT_SPRITES_MAX_SPRITES)!,
        restoreCheckpoint: flag(environment, SPRITES_RESTORE_ENV, true),
        keepAwakeIntervalMs: positiveInteger(environment, SPRITES_KEEP_AWAKE_INTERVAL_ENV, DEFAULT_SPRITES_KEEP_AWAKE_INTERVAL_MS)!,
        workerId,
    };
}

/** Name of this worker's Sprite in `slot`: `<prefix>-<worker>-<slot>`. */
export function spriteNameForSlot(config: Pick<SpritesRuntimeConfig, 'namePrefix' | 'workerId'>, slot: number): string {
    const name = `${config.namePrefix}-${config.workerId}-${slot}`;
    if (name.length > MAX_SPRITE_NAME_LENGTH || !SPRITE_NAME_PATTERN.test(name)) {
        throw new SpritesConfigurationError(`Sprite name "${name}" is not valid`);
    }
    return name;
}

/**
 * The SDK detects its usage-attribution headers once per process, on the
 * first API call: switch them off before then unless the operator chose.
 */
export function applySpritesClientSignalsDefault(environment: NodeJS.ProcessEnv = process.env): void {
    if (environment[SPRITES_CLIENT_SIGNALS_ENV] === undefined) environment[SPRITES_CLIENT_SIGNALS_ENV] = '0';
}
