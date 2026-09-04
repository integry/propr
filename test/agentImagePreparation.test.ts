import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentCliVersionMatrix } from '../packages/core/src/agents/version/versionService.js';

let imageChecks = 0;
let pulls = 0;
let releasePull: (() => void) | undefined;
const pullGate = new Promise<void>(resolve => {
    releasePull = resolve;
});

await mock.module('../packages/core/src/claude/docker/dockerExecutor.js', {
    namedExports: {
        executeDockerCommand: mock.fn(async (_command: string, args: string[]) => {
            if (args[0] === 'images') {
                imageChecks += 1;
                return { exitCode: 0, stdout: '', stderr: '', messageTimestamps: new Map() };
            }
            if (args[0] === 'pull') {
                pulls += 1;
                await pullGate;
                return { exitCode: 0, stdout: 'pulled', stderr: '', messageTimestamps: new Map() };
            }
            throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
        }),
    },
});

const { ensureAgentBundleImage } = await import('../packages/core/src/claude/docker/dockerImageBuilder.js');

test('concurrent preparation of the same bundle shares one Docker operation', async () => {
    const versions: AgentCliVersionMatrix = {
        claude: '1.0.0',
        codex: '1.0.0',
        antigravity: '1.0.0',
        opencode: '1.0.0',
        vibe: '1.0.0',
    };

    const preparations = Array.from({ length: 8 }, () => ensureAgentBundleImage(versions, 'content'));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.strictEqual(imageChecks, 1);
    assert.strictEqual(pulls, 1);

    releasePull?.();
    const results = await Promise.all(preparations);
    assert.ok(results.every(result => result.success));
    assert.strictEqual(new Set(results.map(result => result.imageTag)).size, 1);
});
