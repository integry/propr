import type { DockerRootExecutor } from '../claude/docker/dockerRootDir.js';
import { executeDockerCommand, getDockerRootDir } from '../claude/docker/dockerExecutor.js';

/**
 * Runtime-agent builds install roughly 4 GB of packages and can temporarily
 * retain the bundle, runtime, and intermediate layers at the same time. Keep
 * a 12 GiB byte reserve plus an inode reserve on Docker's storage filesystem
 * so the build has room for its temporary layers and metadata.
 */
export const AGENT_IMAGE_BUILD_MIN_FREE_BYTES = 12 * 1024 ** 3;
export const AGENT_IMAGE_BUILD_MIN_FREE_INODES = 100_000;
// Keep these as fixed safety floors rather than operator-tunable settings:
// lowering them would re-enable the incident class, while raising them is an
// operational capacity decision that should be made with a new image-size
// measurement and regression coverage.

export interface AgentImageBuildDiskSpace {
    availableBytes: number;
    freeInodes: number;
}

export class AgentImageBuildCapacityError extends Error {
    readonly code = 'ENOSPC';
    readonly diskSpace: AgentImageBuildDiskSpace;

    constructor(
        diskSpace: AgentImageBuildDiskSpace,
        minFreeBytes = AGENT_IMAGE_BUILD_MIN_FREE_BYTES,
        minFreeInodes = AGENT_IMAGE_BUILD_MIN_FREE_INODES,
    ) {
        const availableGiB = (diskSpace.availableBytes / 1024 ** 3).toFixed(2);
        const requiredGiB = (minFreeBytes / 1024 ** 3).toFixed(2);
        super(
            `Insufficient disk capacity for agent image preparation (ENOSPC): `
            + `${availableGiB} GiB available, ${diskSpace.freeInodes} free inodes; `
            + `requires at least ${requiredGiB} GiB and ${minFreeInodes} free inodes`,
        );
        this.name = 'AgentImageBuildCapacityError';
        this.diskSpace = diskSpace;
    }
}

export class AgentImageBuildStorageError extends Error {
    readonly code = 'EDOCKERSTORAGE';

    constructor(cause: unknown) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        super(
            'Cannot determine the filesystem backing Docker image/build storage; '
            + `refusing to start agent image preparation: ${detail}`,
        );
        this.name = 'AgentImageBuildStorageError';
        this.cause = cause;
    }
}

/**
 * Docker image/build storage can be separate from the ProPR application
 * filesystem, and its root path belongs to the daemon mount namespace.
 * Bind it in a short-lived helper even when the same path exists locally.
 */
export async function readAgentImageBuildDiskSpace(
    rootPath: string,
    executor: DockerRootExecutor = executeDockerCommand,
): Promise<AgentImageBuildDiskSpace> {
    // Pin the multi-platform BusyBox 1.37.0 manifest. Docker pulls it only if
    // absent; measurement failures (including pull failures) still fail closed.
    const image = 'busybox:1.37.0@sha256:9db7b59979c38555a39def84a31fb98b5296952f9e3afd4f6f11f05b07adfab0';
    const source = `"source=${rootPath.replaceAll('"', '""')}"`;
    const result = await executor('docker', [
        'run', '--rm', '--network=none', '--read-only',
        '--mount', `type=bind,${source},target=/docker-root,readonly,bind-recursive=disabled`,
        image, 'stat', '-f', '-c', '%a %S %c %d', '/docker-root',
    ], { timeout: 60_000 });
    const values = result.stdout.trim().split(/\s+/);
    if (result.exitCode !== 0 || values.length !== 4 || values.some(value => !/^\d+$/.test(value))) {
        throw new Error(`Docker storage measurement failed: ${result.stderr.trim() || result.stdout.trim()}`);
    }
    const [bavail, bsize, files, ffree] = values.map(Number);
    if (!values.every(value => Number.isSafeInteger(Number(value))) || bsize === 0) {
        throw new Error('Docker storage measurement returned invalid filesystem counters');
    }
    return {
        availableBytes: bavail * bsize,
        // Dynamic-inode filesystems such as btrfs report both counters as 0.
        freeInodes: files === 0 ? Number.POSITIVE_INFINITY : ffree,
    };
}

/**
 * Discovery failures, inaccessible daemon storage, and measured low capacity
 * block builds: every build requires a measurement of Docker's filesystem.
 */
export async function assertAgentImageBuildCapacity(options: {
    minFreeBytes?: number;
    minFreeInodes?: number;
    readDiskSpace?: (rootPath: string) => Promise<AgentImageBuildDiskSpace>;
    getDockerRootDir?: () => Promise<string>;
} = {}): Promise<AgentImageBuildDiskSpace> {
    const minFreeBytes = options.minFreeBytes ?? AGENT_IMAGE_BUILD_MIN_FREE_BYTES;
    const minFreeInodes = options.minFreeInodes ?? AGENT_IMAGE_BUILD_MIN_FREE_INODES;
    let dockerRootDir: string;
    try {
        dockerRootDir = await (options.getDockerRootDir ?? getDockerRootDir)();
    } catch (error) {
        throw new AgentImageBuildStorageError(error);
    }
    if (!dockerRootDir.trim()) {
        throw new AgentImageBuildStorageError(new Error('Docker info returned an empty DockerRootDir'));
    }
    let diskSpace: AgentImageBuildDiskSpace;
    try {
        diskSpace = await (options.readDiskSpace ?? readAgentImageBuildDiskSpace)(dockerRootDir);
    } catch (error) {
        throw new AgentImageBuildStorageError(error);
    }
    if (diskSpace.availableBytes < minFreeBytes || diskSpace.freeInodes < minFreeInodes) {
        throw new AgentImageBuildCapacityError(diskSpace, minFreeBytes, minFreeInodes);
    }
    return diskSpace;
}

export function isAgentImageDiskPressureError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /ENOSPC|no space left on device|insufficient disk|insufficient.*inode|not enough.*free (?:space|inode)/i.test(message);
}
