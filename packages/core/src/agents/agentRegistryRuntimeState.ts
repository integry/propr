import logger from '../utils/logger.js';
import { loadAgentRuntimePackageState } from './runtime/agentRuntimePackages.js';

export async function captureRuntimePackageStateVersion(
    setState: (updatedAt: string | undefined, unavailable: boolean) => void,
): Promise<void> {
    try {
        setState((await loadAgentRuntimePackageState()).updatedAt, false);
    } catch (error) {
        logger.warn({ error: (error as Error).message }, 'Could not capture agent runtime package state version');
        setState(undefined, true);
    }
}

export async function hasRuntimePackageStateChanged(
    updatedAt: string | undefined,
    unavailable: boolean,
    setUnavailable: (value: boolean) => void,
): Promise<boolean> {
    if (updatedAt === undefined && !unavailable) return true;
    try {
        const state = await loadAgentRuntimePackageState();
        setUnavailable(false);
        return state.updatedAt !== updatedAt;
    } catch (error) {
        logger.warn({ error: (error as Error).message }, 'Could not check agent runtime package state');
        setUnavailable(true);
        return false;
    }
}

export async function areAgentImagesAvailable(
    images: string[],
    inspect: () => Promise<{ exitCode: number | null }>,
): Promise<boolean> {
    if (images.length === 0) return true;
    try {
        return (await inspect()).exitCode === 0;
    } catch (error) {
        logger.warn({ images, error: (error as Error).message }, 'Could not verify registered agent Docker images');
        return false;
    }
}
