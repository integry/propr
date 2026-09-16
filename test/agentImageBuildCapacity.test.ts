import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDockerRootDir } from '../packages/core/src/claude/docker/dockerExecutor.js';
import {
    AGENT_IMAGE_BUILD_MIN_FREE_BYTES,
    AGENT_IMAGE_BUILD_MIN_FREE_INODES,
    AgentImageBuildCapacityError,
    AgentImageBuildStorageError,
    assertAgentImageBuildCapacity,
    isAgentImageDiskPressureError,
} from '../packages/core/src/agents/agentImageBuildCapacity.js';

test('Docker-root discovery uses Docker info API output', async () => {
    const rootDir = await getDockerRootDir(async (_command, args) => {
        assert.deepStrictEqual(args, ['info', '--format', '{{.DockerRootDir}}']);
        return { exitCode: 0, stdout: '/mnt/docker\n', stderr: '', messageTimestamps: new Map() };
    });

    assert.strictEqual(rootDir, '/mnt/docker');
});

test('agent image preparation stats Docker storage, not PROPR_ROOT or cwd', async () => {
    const inspectedPaths: string[] = [];
    const diskSpace = await assertAgentImageBuildCapacity({
        getDockerRootDir: async () => '/docker/storage',
        readDiskSpace: async rootPath => {
            inspectedPaths.push(rootPath);
            return {
                availableBytes: AGENT_IMAGE_BUILD_MIN_FREE_BYTES + 1,
                freeInodes: AGENT_IMAGE_BUILD_MIN_FREE_INODES + 1,
            };
        },
    });

    assert.strictEqual(diskSpace.availableBytes, AGENT_IMAGE_BUILD_MIN_FREE_BYTES + 1);
    assert.deepStrictEqual(inspectedPaths, ['/docker/storage']);
});

test('low Docker storage blocks a build even when application storage is ample', async () => {
    await assert.rejects(
        () => assertAgentImageBuildCapacity({
            getDockerRootDir: async () => '/docker/storage',
            readDiskSpace: async rootPath => {
                assert.strictEqual(rootPath, '/docker/storage');
                return {
                    availableBytes: AGENT_IMAGE_BUILD_MIN_FREE_BYTES - 1,
                    freeInodes: AGENT_IMAGE_BUILD_MIN_FREE_INODES + 1,
                };
            },
        }),
        (error: unknown) => {
            assert.ok(error instanceof AgentImageBuildCapacityError);
            assert.strictEqual(error.code, 'ENOSPC');
            return true;
        },
    );
});

test('healthy Docker storage permits image preparation', async () => {
    const diskSpace = await assertAgentImageBuildCapacity({
        getDockerRootDir: async () => '/docker/storage',
        readDiskSpace: async rootPath => {
            assert.strictEqual(rootPath, '/docker/storage');
            return {
                availableBytes: AGENT_IMAGE_BUILD_MIN_FREE_BYTES + 1,
                freeInodes: AGENT_IMAGE_BUILD_MIN_FREE_INODES + 1,
            };
        },
    });

    assert.ok(diskSpace.availableBytes > AGENT_IMAGE_BUILD_MIN_FREE_BYTES);
});

test('agent image preparation fails before Docker work when inodes are low', async () => {
    await assert.rejects(
        () => assertAgentImageBuildCapacity({
            getDockerRootDir: async () => '/docker/storage',
            readDiskSpace: async () => ({
                availableBytes: AGENT_IMAGE_BUILD_MIN_FREE_BYTES + 1,
                freeInodes: AGENT_IMAGE_BUILD_MIN_FREE_INODES - 1,
            }),
        }),
        AgentImageBuildCapacityError,
    );
});

test('Docker-root discovery failure fails closed without statfs or build work', async () => {
    let statfsCalled = false;
    await assert.rejects(
        () => assertAgentImageBuildCapacity({
            getDockerRootDir: async () => {
                throw new Error('docker daemon unavailable');
            },
            readDiskSpace: async () => {
                statfsCalled = true;
                return { availableBytes: Number.MAX_SAFE_INTEGER, freeInodes: Number.MAX_SAFE_INTEGER };
            },
        }),
        (error: unknown) => {
            assert.ok(error instanceof AgentImageBuildStorageError);
            assert.strictEqual(error.code, 'EDOCKERSTORAGE');
            assert.match(error.message, /refusing to start agent image preparation/);
            return true;
        },
    );
    assert.strictEqual(statfsCalled, false);
});

test('agent image disk pressure detection recognizes Docker ENOSPC failures', () => {
    assert.strictEqual(isAgentImageDiskPressureError(new Error('write /var/lib/docker: no space left on device')), true);
    assert.strictEqual(isAgentImageDiskPressureError(new Error('temporary registry timeout')), false);
});
