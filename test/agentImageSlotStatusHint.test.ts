import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';

let slotHint: string | undefined;

// The real logger's transport worker can keep the test process alive.
const noop = () => {};
const silentLogger = { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop };
await mock.module('../packages/core/src/utils/logger.js', {
    defaultExport: { ...silentLogger, child: () => silentLogger },
    namedExports: { generateCorrelationId: () => 'test-correlation-id', createCorrelatedLogger: () => silentLogger },
});

await mock.module('../packages/core/src/claude/docker/dockerExecutor.js', {
    namedExports: {
        agentDockerImageExists: async () => false,
        executeDockerCommand: async () => assert.fail('inspect-only resolution must not run Docker'),
        getDockerRootDir: async () => '/var/lib/docker',
        stopDockerContainer: async () => undefined,
        ensureAgentBundleImage: async () => assert.fail('inspect-only resolution must not prepare images'),
        ensureAgentDockerImage: async () => assert.fail('inspect-only resolution must not prepare images'),
    },
});
await mock.module('../packages/core/src/agents/managedAgentImage.js', {
    namedExports: { resolveManagedAgentImage: async () => null },
});
await mock.module('../packages/core/src/agents/agentImageBuildLock.js', {
    namedExports: {
        describeAgentImageBuildSlotWait: async () => slotHint,
        withAgentImageBuildSlot: async () => assert.fail('inspect-only resolution must not take the build slot'),
    },
});

const { resolveUnifiedAgentImage } = await import('../packages/core/src/agents/agentImagePreparation.js');
const { closeConnection } = await import('../packages/core/src/db/connection.js');

// Runtime-package resolution reads settings through the shared pool.
after(() => closeConnection());

test('an unprepared image names the build-slot holder the worker is waiting for', async () => {
    slotHint = 'waiting for build slot held by 0123456789ab pid 1, lease expires in 37m';
    const resolution = await resolveUnifiedAgentImage([], false);
    assert.equal(resolution.image, undefined);
    assert.match(resolution.error ?? '', /has not been prepared by the worker; waiting for build slot held by 0123456789ab pid 1, lease expires in 37m$/);
});

test('an unprepared image with a free slot keeps the plain status', async () => {
    slotHint = undefined;
    const resolution = await resolveUnifiedAgentImage([], false);
    assert.match(resolution.error ?? '', /has not been prepared by the worker$/);
});
