import assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * Live check of the Sprites runtime against a real Sprite: provisioning
 * (pinned CLIs, entrypoints, checkpoint), the root launcher, output
 * following, exit status and startup timings. Skipped unless
 * PROPR_SPRITES_LIVE_TOKEN holds an org-scoped Sprites token. It uses (and
 * keeps, for the next run) the Sprite `<prefix>-live-0`; the prefix defaults
 * to `propr-live` (PROPR_SPRITES_LIVE_PREFIX), the region to the Sprites
 * default (PROPR_SPRITES_LIVE_REGION).
 *
 *   PROPR_SPRITES_LIVE_TOKEN=... npx tsx --test test/spritesRuntime.live.test.ts
 */
const token = process.env.PROPR_SPRITES_LIVE_TOKEN?.trim();

test('a Sprite runs the pinned Claude Code CLI through the propr/agent entrypoint contract', {
    skip: token ? false : 'set PROPR_SPRITES_LIVE_TOKEN to run the live Sprites check',
    timeout: 30 * 60_000,
}, async () => {
    const { SpritesRuntime } = await import('../packages/core/src/agents/runtime/spritesRuntime.ts');
    const { readSpritesCliPins } = await import('../packages/core/src/agents/runtime/sprites/spritesProvisioning.ts');
    const { AgentRunSpecBuilder, agentRunNetwork } = await import('../packages/core/src/agents/runtime/agentRunSpec.ts');
    const runtime = new SpritesRuntime({
        environment: {
            ...process.env,
            PROPR_SPRITES_TOKEN: token,
            PROPR_SPRITES_NAME_PREFIX: process.env.PROPR_SPRITES_LIVE_PREFIX || 'propr-live',
            PROPR_SPRITES_WORKER_ID: 'live',
            PROPR_SPRITES_MAX_SPRITES: '1',
            ...(process.env.PROPR_SPRITES_LIVE_REGION ? { PROPR_SPRITES_REGION: process.env.PROPR_SPRITES_LIVE_REGION } : {}),
        },
    });
    const spec = new AgentRunSpecBuilder({
        agentType: 'claude', image: 'propr/agent:live', name: `claude-sprites-live-${Date.now()}`, stdin: true, user: '0:0',
        network: agentRunNetwork('bridge'),
        workspace: { hostPath: '/tmp/unused', containerPath: '/home/node/workspace', readOnly: false },
    }).bind('/tmp/claude-logs', '/tmp/claude-logs', false, 'logs').env('PROPR_LIVE_CHECK', '1').command('claude', '--version').build();
    // No repository: the transport wrapper and setup hook only start the provider entrypoint.
    spec.repoSetup = { agentType: 'claude', shell: '/bin/bash', script: 'exec "$0" "$@"', providerEntrypoint: '/home/node/claude-entrypoint.sh', env: [] };
    spec.workspace = {
        ...spec.workspace, mode: 'clone',
        clone: { remote: 'https://github.com/example/none.git', baseRef: 'none', baseCommit: 'none', branch: 'none', resultDir: '/tmp/propr-workspace-result', script: 'exec /bin/bash -lc "$0" "$@"' },
    };
    const handle = runtime.start(spec, { timeout: 25 * 60_000, stdinData: '' });
    try {
        const result = await handle.wait();
        console.log(JSON.stringify({ sprite: 'live', exitCode: result.exitCode, timings: handle.timings }));
        assert.equal(result.exitCode, 0, result.stderr);
        assert.match(result.stdout, new RegExp(readSpritesCliPins().CLAUDE_CLI_VERSION.replace(/\./g, '\\.')));
        assert.match(result.stdout, /Switching to node user/);
        for (const key of ['wakeMs', 'credentialSyncMs', 'totalMs'] as const) assert.equal(typeof handle.timings[key], 'number');
    } finally {
        await handle.release();
    }
});
