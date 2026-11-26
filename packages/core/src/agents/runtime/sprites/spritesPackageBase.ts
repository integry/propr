import type { Sprite } from '@fly/sprites';
import logger from '../../../utils/logger.js';
import { checkAgentRuntimePackagesBeforeInstall, type AgentRuntimePackageLoader } from '../agentRuntimePackageIndex.js';
import { startupStep } from '../startupStep.js';

/**
 * Reads the Sprites runtime package list (normalized); a Sprite is provisioned with exactly these installed.
 * Its availability check, if any, runs only before a new Sprite is created to install them. `detectBase`,
 * if any, reads a new Sprite's distribution and apt sources, and is true when the recorded base changed.
 */
export type SpritePackageSource = AgentRuntimePackageLoader & { detectBase?: (sprite: Sprite, signal: AbortSignal) => Promise<boolean> };

/**
 * Records a new Sprite's distribution and apt sources, which Settings and the pre-install check validate
 * names against. When they differ from the base the list was just checked against (the first Sprite, or
 * Fly moved Sprites to a new base), the list is checked again before apt runs. A failed detection is
 * logged and does not fail provisioning.
 */
export async function detectSpritePackageBaseBeforeInstall(source: SpritePackageSource, sprite: Sprite, packages: readonly string[], signal: AbortSignal) {
    const detect = source.detectBase;
    if (!detect) return;
    const changed = await startupStep(signal, () => detect(sprite, signal)).catch(error => {
        signal.throwIfAborted();
        logger.warn({ sprite: sprite.name, error: error instanceof Error ? error.message : String(error) }, 'Could not detect the Sprite base package sources');
        return false;
    });
    if (changed) await startupStep(signal, () => checkAgentRuntimePackagesBeforeInstall(source, packages, signal));
}
