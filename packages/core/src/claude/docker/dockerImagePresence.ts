import { executeDockerCommand } from './dockerExecutor.js';

/**
 * Whether the exact image reference is present locally. `docker images -q`
 * only filters by repository[:tag], so it never matches a digest-pinned
 * `repo:tag@sha256:…` reference (such as a Desktop managed agent pin) and
 * reports it missing. `docker image inspect` resolves tags, image IDs and
 * digest references alike; only a successful inspect reporting an ID counts.
 */
export async function agentDockerImageExists(image: string, timeout = 30000): Promise<boolean> {
    const result = await executeDockerCommand('docker', ['image', 'inspect', '--format', '{{.Id}}', image], { timeout });
    return result.exitCode === 0 && Boolean(result.stdout.trim());
}
