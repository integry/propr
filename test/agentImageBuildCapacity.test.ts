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
    readAgentImageBuildDiskSpace,
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

    assert.ok(diskSpace);
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

    assert.ok(diskSpace);
    assert.ok(diskSpace.availableBytes > AGENT_IMAGE_BUILD_MIN_FREE_BYTES);
});

for (const code of ['ENOENT', 'EACCES', 'ENOTDIR']) {
    test(`failed daemon-side measurement (${code}) blocks build work`, async () => {
        const inspectedPaths: string[] = [];
        let buildCalled = false;
        const prepare = async () => {
            await assertAgentImageBuildCapacity({
                getDockerRootDir: async () => '/daemon/docker',
                readDiskSpace: async rootPath => {
                    inspectedPaths.push(rootPath);
                    throw Object.assign(new Error(`daemon helper failed: ${code}`), { code });
                },
            });
            buildCalled = true;
        };

        await assert.rejects(prepare, (error: unknown) => {
            assert.ok(error instanceof AgentImageBuildStorageError);
            assert.strictEqual((error.cause as NodeJS.ErrnoException).code, code);
            return true;
        });
        assert.strictEqual(buildCalled, false);
        assert.deepStrictEqual(inspectedPaths, ['/daemon/docker']);
    });
}

test('unexpected daemon measurement errors still block image preparation', async () => {
    const failure = Object.assign(new Error('I/O failure'), { code: 'EIO' });
    await assert.rejects(
        () => assertAgentImageBuildCapacity({
            getDockerRootDir: async () => '/daemon/docker',
            readDiskSpace: async () => { throw failure; },
        }),
        error => error instanceof AgentImageBuildStorageError && error.cause === failure,
    );
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


test('capacity is measured in the daemon namespace even when its root is absent locally', async () => {
    const root = '/daemon-only/docker-storage';
    const measured = await readAgentImageBuildDiskSpace(root, async (command, args) => {
        assert.strictEqual(command, 'docker');
        assert.deepStrictEqual(args.slice(0, 6), ['run', '--rm', '--network=none', '--read-only', '--mount',
            'type=bind,"source=/daemon-only/docker-storage",target=/docker-root,readonly,bind-recursive=disabled']);
        assert.match(args[6], /^busybox:1\.37\.0@sha256:[a-f0-9]{64}$/);
        assert.deepStrictEqual(args.slice(7), ['stat', '-f', '-c', '%a %S %c %d', '/docker-root']);
        return { exitCode: 0, stdout: '4000000 4096 1000000 200000\n', stderr: '' };
    });
    assert.deepStrictEqual(measured, { availableBytes: 4000000 * 4096, freeInodes: 200000 });
});

test('dynamic-inode filesystems skip the inode floor but retain the byte floor', async () => {
    for (const blocks of [4000000, 1]) {
        const disk = await readAgentImageBuildDiskSpace('/btrfs/docker', async () => ({
            exitCode: 0, stdout: `${blocks} 4096 0 0\n`, stderr: '',
        }));
        assert.strictEqual(disk.freeInodes, Number.POSITIVE_INFINITY);
        const check = assertAgentImageBuildCapacity({
            getDockerRootDir: async () => '/btrfs/docker',
            readDiskSpace: async () => disk,
        });
        if (blocks === 1) await assert.rejects(check, AgentImageBuildCapacityError);
        else assert.strictEqual(await check, disk);
    }
});

for (const stdout of ['', '1 4096 100', '1 0 100 100', 'NaN 4096 100 100', '1 4096 100 -1']) {
    test(`invalid daemon capacity output fails closed: ${JSON.stringify(stdout)}`, async () => {
        await assert.rejects(readAgentImageBuildDiskSpace('/docker', async () => ({
            exitCode: 0, stdout, stderr: '',
        })), /Docker storage measurement/);
    });
}

test('daemon helper failure preserves the underlying storage error', async () => {
    await assert.rejects(readAgentImageBuildDiskSpace('/docker', async () => ({
        exitCode: 1, stdout: '', stderr: 'no space left on device',
    })), /no space left on device/);
});
