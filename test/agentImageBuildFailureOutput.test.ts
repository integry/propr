import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { AgentCliVersionMatrix } from '../packages/core/src/agents/version/versionService.js';

await mock.module('../packages/core/src/utils/logger.js', {
    defaultExport: {
        trace: () => {}, debug: () => {}, info: () => {},
        warn: () => {}, error: () => {}, fatal: () => {},
    },
});

let buildResult = { exitCode: 1, stdout: '', stderr: '' };
await mock.module('../packages/core/src/claude/docker/dockerExecutor.js', {
    namedExports: {
        getDockerRootDir: async () => '/docker/storage',
        executeDockerCommand: mock.fn(async (_command: string, args: string[]) => {
            const empty = { stdout: '', stderr: '', messageTimestamps: new Map() };
            // The tag exists neither locally nor in the registry, so the build
            // path runs against a storage filesystem with ample capacity.
            if (args[0] === 'images') return { exitCode: 0, ...empty };
            if (args[0] === 'pull') return { exitCode: 1, ...empty };
            if (args[0] === 'run') return { ...empty, exitCode: 0, stdout: '10000000 4096 1000000 900000' };
            if (args[0] === 'build') return { ...buildResult, messageTimestamps: new Map() };
            throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
        }),
    },
});
await mock.module('../packages/core/src/agents/agentImageBuildLock.js', {
    namedExports: { withAgentImageBuildSlot: <T>(work: () => Promise<T>) => work() },
});

const { isAgentImageDiskPressureError } = await import('../packages/core/src/agents/agentImageBuildCapacity.js');
const { ensureAgentBundleImage } = await import('../packages/core/src/claude/docker/dockerImageBuilder.js');

const versions: AgentCliVersionMatrix = {
    claude: '1.0.0', codex: '1.0.0', antigravity: '1.0.0', opencode: '1.0.0', vibe: '1.0.0',
};

for (const stream of ['stdout', 'stderr'] as const) {
    test(`failed bundle builds classify disk pressure reported on ${stream}`, async () => {
        const message = 'write /var/lib/docker/tmp/layer: no space left on device';
        buildResult = {
            exitCode: 100,
            stdout: stream === 'stdout' ? message : '',
            stderr: stream === 'stderr' ? message : '',
        };
        const result = await ensureAgentBundleImage(versions, `disk-pressure-${stream}`);
        assert.strictEqual(result.success, false);
        assert.match(result.error || '', /exit code 100/);
        assert.match(result.error || '', /no space left on device/);
        assert.strictEqual(isAgentImageDiskPressureError(result.error), true);
    });
}

test('failed bundle builds keep both output streams for transient diagnostics', async () => {
    buildResult = { exitCode: 1, stdout: 'step 4/9 failed', stderr: 'npm ERR! network timeout' };
    const result = await ensureAgentBundleImage(versions, 'transient');
    assert.strictEqual(result.success, false);
    assert.match(result.error || '', /npm ERR! network timeout/);
    assert.match(result.error || '', /step 4\/9 failed/);
    assert.strictEqual(isAgentImageDiskPressureError(result.error), false);
});
