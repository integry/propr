/**
 * Agent runtime choice in the Fly dashboard launch wizard (#3827). Each
 * choice is validated before it is saved: a Sprites token must list the
 * organization's Sprites, a Fly token must read the separate agent app. The
 * tokens are stored on the volume like the other wizard values and never
 * logged or echoed back.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve as resolveDns } from 'node:dns/promises';
import { join } from 'node:path';
import { PROPR_VERSION, spritePoolKey } from '@propr/shared';
import type { LaunchRuntime } from './launchConfig.js';

/** The published agent image of this ProPR version on Docker Hub (built by the release from Dockerfile.agent). */
export const DEFAULT_AGENT_IMAGE = `propr/agent:${PROPR_VERSION}`;
/** Machines the Fly Free Plan allows per organization, stopped ones included. */
export const FREE_PLAN_MACHINES = 3;
/** The Sprites tokens page of the personal organization (other organizations switch org there). */
export const SPRITES_TOKENS_URL = 'https://fly.io/dashboard/personal/sprites/tokens';

/**
 * The name prefix every Sprite of this instance gets: `propr-<marker>-`, the
 * marker as SpriteInventory derives it (packages/core sprites/spritesInventory.ts):
 * the one persisted in DATA_DIR when there is one, else the first 16 hex of
 * sha256(spritePoolKey(PROPR_INSTANCE_ID)). test/spritesPool.test.ts keeps the two in step.
 */
export function spritesNamePrefix(instanceId: string, dataDir: string): string {
    const digest = createHash('sha256').update(spritePoolKey(instanceId)).digest('hex').slice(0, 16);
    let saved = '';
    try { saved = readFileSync(join(dataDir, `sprites-deployment-${digest}`), 'utf8').trim(); } catch { /* none yet: the digest */ }
    return `propr-${/^[0-9a-f]{16}$/.test(saved) ? saved : digest}-`;
}

/**
 * Machines of this app, from the private-network `vms.<app>.internal` TXT
 * record (started Machines only); undefined outside Fly or when it fails.
 */
export async function countAppMachines(app: string, timeoutMs = 2_000): Promise<number | undefined> {
    if (!/^[a-z0-9-]+$/.test(app)) return undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
        const records = await Promise.race([
            resolveDns(`vms.${app}.internal`, 'TXT') as Promise<string[][]>,
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); }),
        ]);
        const ids = records.map(chunks => chunks.join('')).join(',').split(',').map(entry => entry.trim()).filter(Boolean);
        return ids.length || undefined;
    } catch {
        return undefined;
    } finally {
        clearTimeout(timer);
    }
}

/** The default for "Agent Machines at once": the Free Plan's Machines minus this app's (one when unknown). */
export function defaultAgentMachines(controlPlaneMachines: number | undefined): number {
    return Math.max(1, FREE_PLAN_MACHINES - (controlPlaneMachines ?? 1));
}

export interface RuntimeChoice {
    runtime: LaunchRuntime;
    spritesToken?: string;
    flyApp?: string;
    flyToken?: string;
    flyImage?: string;
    flyMachinesMax?: string;
}

/** `summary`: what the check found, shown on the next step (never a token). */
export type RuntimeValidation = { ok: true; env: Record<string, string>; summary?: string } | { ok: false; error: string };

/** What listing Sprites told about the token's organization; every field is optional. */
export interface SpritesCheck {
    organization?: string;
    running?: number;
    runningLimit?: number;
}

export interface RuntimeValidators {
    /** Resolves when the token can list this instance's Sprites (names under `prefix`); rejects otherwise. */
    sprites(token: string, prefix?: string): Promise<SpritesCheck | void>;
    /** HTTP status of GET /v1/apps/<app> on the Machines API with the token. */
    flyApp(app: string, token: string): Promise<number>;
    /** Machines in the agent app now; undefined when the list cannot be read. */
    flyMachineCount?(app: string, token: string): Promise<number | undefined>;
}

/** Macaroon tokens (`fly tokens create deploy`) carry their own `FlyV1 ` scheme; anything else is a Bearer token. */
export function flyAuthorization(token: string): string {
    const trimmed = token.trim();
    return /^FlyV1\s/.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
}

export const defaultRuntimeValidators: RuntimeValidators = {
    async sprites(token, prefix) {
        const { SpritesClient } = await import('@fly/sprites');
        // Listed under the instance's prefix, so a token scoped to that prefix passes too.
        const list = await new SpritesClient(token).listSprites({ maxResults: 1, ...(prefix ? { prefix } : {}) });
        return { organization: list.organizationName, running: list.running, runningLimit: list.runningLimit };
    },
    async flyApp(app, token) {
        const response = await fetch(`https://api.machines.dev/v1/apps/${encodeURIComponent(app)}`, {
            headers: { Authorization: flyAuthorization(token), Accept: 'application/json' },
            signal: AbortSignal.timeout(20_000),
        });
        await response.body?.cancel();
        return response.status;
    },
    async flyMachineCount(app, token) {
        try {
            const response = await fetch(`https://api.machines.dev/v1/apps/${encodeURIComponent(app)}/machines`, {
                headers: { Authorization: flyAuthorization(token), Accept: 'application/json' },
                signal: AbortSignal.timeout(20_000),
            });
            if (!response.ok) {
                await response.body?.cancel();
                return undefined;
            }
            const machines = await response.json() as unknown;
            return Array.isArray(machines) ? machines.length : undefined;
        } catch {
            return undefined;
        }
    },
};

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/** "Token works · personal · 2 of 3 Sprites free", as far as the listing told. */
export function spritesSummary(check: SpritesCheck | void): string {
    const parts = ['Token works'];
    if (check?.organization) parts.push(`organization ${check.organization}`);
    const { running, runningLimit } = check ?? {};
    if (typeof runningLimit === 'number' && runningLimit > 0 && typeof running === 'number') {
        parts.push(`${Math.max(0, runningLimit - running)} of ${plural(runningLimit, 'Sprite')} free`);
    }
    return parts.join(' · ');
}

const IMAGE_REFERENCE = /^[a-z0-9][a-z0-9.-]*(?::\d+)?\/[a-z0-9._/-]+(?::[\w.-]+|@sha256:[0-9a-f]{64})$/;

async function validateSprites(choice: RuntimeChoice, prefix: string | undefined, validators: RuntimeValidators): Promise<RuntimeValidation> {
    const token = choice.spritesToken?.trim();
    if (!token) return { ok: false, error: 'Paste a Sprites token.' };
    let check: SpritesCheck | void;
    try {
        check = await validators.sprites(token, prefix);
    } catch {
        return { ok: false, error: 'That Sprites token could not list Sprites. Check the token, its organization and its name prefix.' };
    }
    // A small installation starts with one Sprite (the docs' recommendation for the Free Plan).
    return {
        ok: true,
        env: { PROPR_AGENT_RUNTIME: 'sprites', SPRITES_TOKEN: token, PROPR_SPRITES_MAX: '1', WORKER_CONCURRENCY: '1' },
        summary: spritesSummary(check),
    };
}

function flyMachinesInputError(choice: RuntimeChoice, controlPlaneApp: string | undefined): string | null {
    const app = choice.flyApp?.trim() ?? '';
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/.test(app)) return 'Enter the agent app name (lowercase letters, digits and dashes).';
    if (controlPlaneApp && app === controlPlaneApp) return 'Use a separate Fly app for agents, not this control-plane app.';
    if (!choice.flyToken?.trim()) return 'Paste a deploy token scoped to the agent app.';
    if (!IMAGE_REFERENCE.test(choice.flyImage?.trim() || DEFAULT_AGENT_IMAGE)) return `Enter the agent image, for example ${DEFAULT_AGENT_IMAGE}.`;
    if (!/^[1-9]\d{0,2}$/.test(choice.flyMachinesMax?.trim() || '2')) return 'Agent Machines at once must be a whole number from 1.';
    return null;
}

function flyAppStatusError(app: string, status: number): string | null {
    if (status === 404) return `The Fly app ${app} does not exist, or the token cannot see it.`;
    if (status === 401 || status === 403) return `That token cannot read the Fly app ${app}. Create a deploy token for that app.`;
    if (status < 200 || status >= 300) return `The Fly Machines API answered HTTP ${status}.`;
    return null;
}

async function validateFlyMachines(choice: RuntimeChoice, controlPlaneApp: string | undefined, validators: RuntimeValidators): Promise<RuntimeValidation> {
    const inputError = flyMachinesInputError(choice, controlPlaneApp);
    if (inputError) return { ok: false, error: inputError };
    const app = choice.flyApp!.trim();
    const token = choice.flyToken!.trim();
    let status: number;
    try {
        status = await validators.flyApp(app, token);
    } catch {
        return { ok: false, error: 'The Fly Machines API could not be reached. Try again.' };
    }
    const statusError = flyAppStatusError(app, status);
    if (statusError) return { ok: false, error: statusError };
    const max = choice.flyMachinesMax?.trim() || '2';
    const machines = await validators.flyMachineCount?.(app, token).catch(() => undefined);
    const found = typeof machines === 'number' ? ` · ${plural(machines, 'Machine')} in it now` : '';
    return {
        ok: true,
        env: {
            PROPR_AGENT_RUNTIME: 'fly-machines', PROPR_FLY_APP: app, PROPR_FLY_API_TOKEN: token, PROPR_FLY_IMAGE: choice.flyImage?.trim() || DEFAULT_AGENT_IMAGE,
            PROPR_FLY_MACHINES_MAX: max, WORKER_CONCURRENCY: '1',
        },
        summary: `Token works · agent app ${app}${found} · up to ${plural(Number(max), 'agent Machine')} at once`,
    };
}

export async function validateRuntimeChoice(
    choice: RuntimeChoice,
    context: { controlPlaneApp?: string; spritesPrefix?: string },
    validators: RuntimeValidators = defaultRuntimeValidators,
): Promise<RuntimeValidation> {
    switch (choice.runtime) {
        // Control plane only: agent runs fail with "Set PROPR_SPRITES_TOKEN" until a runtime is added.
        case 'none': return { ok: true, env: { PROPR_AGENT_RUNTIME: 'sprites' } };
        case 'sprites': return validateSprites(choice, context.spritesPrefix, validators);
        case 'fly-machines': return validateFlyMachines(choice, context.controlPlaneApp, validators);
        default: return { ok: false, error: 'Choose an agent runtime.' };
    }
}

/** Env keys a runtime choice owns; saving one choice clears the others'. */
export const RUNTIME_ENV_KEYS = [
    'PROPR_AGENT_RUNTIME', 'SPRITES_TOKEN', 'PROPR_SPRITES_MAX', 'PROPR_FLY_APP', 'PROPR_FLY_API_TOKEN', 'PROPR_FLY_IMAGE', 'PROPR_FLY_MACHINES_MAX', 'WORKER_CONCURRENCY',
] as const;
