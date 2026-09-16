import fs from 'node:fs/promises';
import { getDockerRootDir } from '../claude/docker/dockerExecutor.js';

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
 * filesystem. Query Docker's daemon root through its info API and statfs that
 * path. If the daemon root cannot be resolved, fail closed: falling back to
 * PROPR_ROOT or cwd could approve a build while Docker's filesystem is full.
 */
export async function readAgentImageBuildDiskSpace(
    rootPath: string,
): Promise<AgentImageBuildDiskSpace> {
    const stats = await fs.statfs(rootPath);
    return {
        availableBytes: Number(stats.bavail) * Number(stats.bsize),
        freeInodes: Number(stats.ffree),
    };
}

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
    const diskSpace = await (options.readDiskSpace ?? readAgentImageBuildDiskSpace)(dockerRootDir);
    if (diskSpace.availableBytes < minFreeBytes || diskSpace.freeInodes < minFreeInodes) {
        throw new AgentImageBuildCapacityError(diskSpace, minFreeBytes, minFreeInodes);
    }
    return diskSpace;
}

export function isAgentImageDiskPressureError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /ENOSPC|no space left on device|insufficient disk|insufficient.*inode|not enough.*free (?:space|inode)/i.test(message);
}
