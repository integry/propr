import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** The checkout whose `Dockerfile.agent` pins the Sprite agent CLIs and whose `scripts/` provisioning uploads. */
export const projectRoot = () => process.env.PROPR_ROOT
    || (existsSync(path.join(process.cwd(), 'Dockerfile.agent')) ? process.cwd() : '/usr/src/app');
const pinNames = ['CLAUDE_CLI_VERSION', 'CODEX_CLI_VERSION', 'ANTIGRAVITY_CLI_VERSION', 'ANTIGRAVITY_CLI_RELEASE_ID', 'ANTIGRAVITY_CLI_SHA512'] as const;
export type SpritesCliPins = Record<typeof pinNames[number], string>;

const pinsByRoot = new Map<string, SpritesCliPins>();

export function readSpritesCliPins(root = projectRoot()): SpritesCliPins {
    const cached = pinsByRoot.get(root);
    if (cached) return cached;
    const dockerfile = readFileSync(path.join(root, 'Dockerfile.agent'), 'utf8');
    const pins = Object.fromEntries(pinNames.map(name => {
        const value = new RegExp(`^ARG ${name}=([a-zA-Z0-9.+_-]+)$`, 'm').exec(dockerfile)?.[1];
        if (!value) throw new Error(`Missing ${name} pin in Dockerfile.agent`);
        return [name, value];
    })) as SpritesCliPins;
    pinsByRoot.set(root, Object.freeze(pins));
    return pins;
}
