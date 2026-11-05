import { execFileSync } from 'child_process';
import logger from '../../utils/logger.js';

export function detectContainerId(
    worktreePath: string,
    state: { containerIdDetected: boolean; containerId: { value: string | null } },
    onContainerId?: (containerId: string, containerName: string) => void | Promise<void>,
    invokeCallback?: (callback: () => void | Promise<void>) => void,
): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
        if (state.containerIdDetected) return;
        try {
            const out = execFileSync('/usr/bin/docker', [
                'ps',
                '--filter', `volume=${worktreePath}`,
                '--format', '{{.ID}}:{{.Names}}',
                '--latest',
            ], { encoding: 'utf8', timeout: 5000 }).trim();
            if (out) {
                const [id, name] = out.split(':');
                state.containerIdDetected = true;
                state.containerId.value = id;
                if (onContainerId && invokeCallback) invokeCallback(() => onContainerId(id, name));
                logger.debug({ containerId: id, containerName: name, worktreePath }, 'Detected Docker container ID');
            }
        } catch (err) { logger.debug({ error: (err as Error).message }, 'Failed to detect container ID'); }
    }, 2000);
}
