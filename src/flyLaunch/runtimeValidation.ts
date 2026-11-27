/**
 * Agent runtime choice in the Fly dashboard launch wizard (#3827). Each
 * choice is validated before it is saved: a Sprites token must list the
 * organization's Sprites, a Fly token must read the separate agent app. The
 * tokens are stored on the volume like the other wizard values and never
 * logged or echoed back.
 */
import type { LaunchRuntime } from './launchConfig.js';

export interface RuntimeChoice {
    runtime: LaunchRuntime;
    spritesToken?: string;
    flyApp?: string;
    flyToken?: string;
    flyImage?: string;
    flyMachinesMax?: string;
}

export type RuntimeValidation = { ok: true; env: Record<string, string> } | { ok: false; error: string };

export interface RuntimeValidators {
    /** Resolves when the token can list Sprites; rejects otherwise. */
    sprites(token: string): Promise<void>;
    /** HTTP status of GET /v1/apps/<app> on the Machines API with the token. */
    flyApp(app: string, token: string): Promise<number>;
}

/** Macaroon tokens (`fly tokens create deploy`) carry their own `FlyV1 ` scheme; anything else is a Bearer token. */
export function flyAuthorization(token: string): string {
    const trimmed = token.trim();
    return /^FlyV1\s/.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
}

export const defaultRuntimeValidators: RuntimeValidators = {
    async sprites(token) {
        const { SpritesClient } = await import('@fly/sprites');
        await new SpritesClient(token).listSprites({ maxResults: 1 });
    },
    async flyApp(app, token) {
        const response = await fetch(`https://api.machines.dev/v1/apps/${encodeURIComponent(app)}`, {
            headers: { Authorization: flyAuthorization(token), Accept: 'application/json' },
            signal: AbortSignal.timeout(20_000),
        });
        await response.body?.cancel();
        return response.status;
    },
};

const IMAGE_REFERENCE = /^[a-z0-9][a-z0-9.-]*(?::\d+)?\/[a-z0-9._/-]+(?::[\w.-]+|@sha256:[0-9a-f]{64})$/;

async function validateSprites(choice: RuntimeChoice, validators: RuntimeValidators): Promise<RuntimeValidation> {
    const token = choice.spritesToken?.trim();
    if (!token) return { ok: false, error: 'Paste a Sprites token.' };
    try {
        await validators.sprites(token);
    } catch {
        return { ok: false, error: 'That Sprites token could not list your Sprites. Check the token and its organization.' };
    }
    // A small installation starts with one Sprite (the docs' recommendation for the Free Plan).
    return { ok: true, env: { PROPR_AGENT_RUNTIME: 'sprites', SPRITES_TOKEN: token, PROPR_SPRITES_MAX: '1', WORKER_CONCURRENCY: '1' } };
}

function flyMachinesInputError(choice: RuntimeChoice, controlPlaneApp: string | undefined): string | null {
    const app = choice.flyApp?.trim() ?? '';
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/.test(app)) return 'Enter the agent app name (lowercase letters, digits and dashes).';
    if (controlPlaneApp && app === controlPlaneApp) return 'Use a separate Fly app for agents, not this control-plane app.';
    if (!choice.flyToken?.trim()) return 'Paste a deploy token scoped to the agent app.';
    if (!IMAGE_REFERENCE.test(choice.flyImage?.trim() ?? '')) return 'Enter the agent image, for example registry.fly.io/<agent-app>@sha256:<digest>.';
    if (!/^[1-9]\d{0,2}$/.test(choice.flyMachinesMax?.trim() || '2')) return 'Concurrent agent Machines must be a whole number from 1.';
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
    return {
        ok: true,
        env: {
            PROPR_AGENT_RUNTIME: 'fly-machines', PROPR_FLY_APP: app, PROPR_FLY_API_TOKEN: token, PROPR_FLY_IMAGE: choice.flyImage!.trim(),
            PROPR_FLY_MACHINES_MAX: choice.flyMachinesMax?.trim() || '2', WORKER_CONCURRENCY: '1',
        },
    };
}

export async function validateRuntimeChoice(
    choice: RuntimeChoice,
    context: { controlPlaneApp?: string },
    validators: RuntimeValidators = defaultRuntimeValidators,
): Promise<RuntimeValidation> {
    switch (choice.runtime) {
        // Control plane only: agent runs fail with "Set PROPR_SPRITES_TOKEN" until a runtime is added.
        case 'none': return { ok: true, env: { PROPR_AGENT_RUNTIME: 'sprites' } };
        case 'sprites': return validateSprites(choice, validators);
        case 'fly-machines': return validateFlyMachines(choice, context.controlPlaneApp, validators);
        default: return { ok: false, error: 'Choose an agent runtime.' };
    }
}

/** Env keys a runtime choice owns; saving one choice clears the others'. */
export const RUNTIME_ENV_KEYS = [
    'PROPR_AGENT_RUNTIME', 'SPRITES_TOKEN', 'PROPR_SPRITES_MAX', 'PROPR_FLY_APP', 'PROPR_FLY_API_TOKEN', 'PROPR_FLY_IMAGE', 'PROPR_FLY_MACHINES_MAX', 'WORKER_CONCURRENCY',
] as const;
