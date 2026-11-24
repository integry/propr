import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import logger from '../utils/logger.js';
import { dockerAgentRuntimeInUse } from '../agents/runtime/runtimeSelection.js';

const execFileAsync = promisify(execFile);

export type WorktreeMount = string | { source: string; service: boolean };
type DockerQuery = (command: string, args: string[], options: { timeout: number }) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;

// Keep mount inspection independent of agent execution, queues and their timers.
const queryDocker: DockerQuery = async (command, args, options) => {
    try {
        const result = await execFileAsync(command, args, { ...options, maxBuffer: 16 * 1024 * 1024 });
        return { ...result, exitCode: 0 };
    } catch (error) {
        const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
        if (typeof failure.code !== 'number') throw error;
        return { exitCode: failure.code, stdout: failure.stdout ?? '', stderr: failure.stderr ?? failure.message };
    }
};

/** The Docker CLI is missing, or its daemon cannot be reached at all. */
function dockerUnreachable(failure: { exitCode: number | null; stderr: string } | Error): boolean {
    if (failure instanceof Error) return (failure as NodeJS.ErrnoException).code === 'ENOENT';
    return /Cannot connect to the Docker daemon|error during connect|docker: not found|No such file or directory/i.test(failure.stderr);
}

/**
 * Host paths mounted into running containers. Throws when Docker can't be read,
 * except on a worker whose agents run on another runtime (Sprites) and has
 * no reachable Docker: no container can mount anything there.
 */
export async function runningContainerMountSources(
    executeDockerCommand: DockerQuery = queryDocker,
    environment: NodeJS.ProcessEnv = process.env,
): Promise<WorktreeMount[]> {
    let listed: Awaited<ReturnType<DockerQuery>>;
    try {
        listed = await executeDockerCommand('docker', ['ps', '-q', '--no-trunc'], { timeout: 15_000 });
    } catch (error) {
        if (!dockerAgentRuntimeInUse([], environment) && dockerUnreachable(error as Error)) return [];
        throw error;
    }
    if (listed.exitCode !== 0 && !dockerAgentRuntimeInUse([], environment) && dockerUnreachable(listed)) return [];
    if (listed.exitCode !== 0) throw new Error(`docker ps failed: ${listed.stderr.trim()}`);
    const ids = listed.stdout.split('\n').map(id => id.trim()).filter(Boolean);
    if (ids.length === 0) return [];
    const inspected = await executeDockerCommand('docker', [
        'inspect', '--format', '{{json .Config.Cmd}}\t{{json .Config.Labels}}\t{{json .Mounts}}', ...ids,
    ], { timeout: 30_000 });
    // A container can exit between ps and inspect; any other failure is unknown liveness.
    if (inspected.exitCode !== 0 && !/No such (object|container)/i.test(inspected.stderr)) {
        throw new Error(`docker inspect failed: ${inspected.stderr.trim()}`);
    }
    return inspected.stdout.split('\n').filter(line => line.trim()).flatMap(line => {
        const [commandJson, labelsJson, mountsJson] = line.split('\t');
        const command: unknown = JSON.parse(commandJson);
        const labels = JSON.parse(labelsJson) as Record<string, string> | null;
        const mounts = JSON.parse(mountsJson) as Array<{ Source: string }>;
        // Service identity is a deployment label, independent of wrappers,
        // entrypoints and additional command arguments. Unlabelled tasks fail closed.
        const services = ['daemon', 'worker', 'indexing-worker', 'api'];
        const service = services.includes(labels?.['propr.service'] ?? '')
            || services.includes(labels?.['com.docker.compose.service'] ?? '');
        void command; // Parse/validate the complete Docker response even with label identity.
        return mounts.map(mount => {
            if (typeof mount.Source !== 'string') throw new Error('Invalid Docker mount source');
            return { source: mount.Source, service };
        });
    });
}


let startupProbe: Promise<void> | undefined;
/** A process-level diagnostic; each removal still refreshes Docker authority. */
export function probeWorktreeReclamationDocker(): Promise<void> {
    if (!dockerAgentRuntimeInUse()) return Promise.resolve();
    return startupProbe ??= runningContainerMountSources().then(() => undefined).catch(error => {
        logger.warn({ error: (error as Error).message }, 'Worktree reclamation disabled: Docker unavailable; provide the Docker CLI on PATH and access to its socket');
    });
}
