import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

/**
 * Live check of the Sprites runtime against a real Sprite. Skipped unless
 * PROPR_SPRITES_LIVE_TOKEN holds an org-scoped Sprites token.
 *
 *   PROPR_SPRITES_LIVE_TOKEN=... npx tsx --test test/spritesRuntime.live.test.ts
 *
 * It uses the Sprite `<prefix>-live-0` (prefix `propr-live`, or
 * PROPR_SPRITES_LIVE_PREFIX; region PROPR_SPRITES_LIVE_REGION) and deletes it
 * afterwards unless PROPR_SPRITES_LIVE_KEEP=1.
 *
 * Run 1 (cold) provisions the Sprite with the real setup script (pinned
 * Claude Code, Codex and Antigravity CLIs), takes the clean checkpoint and
 * runs through the real launcher: the provider entrypoint runs as the
 * unprivileged `node` user without sudo, cannot read the run directory, and
 * the "refreshed" credential comes back through the export. It leaves files
 * in every place a run can write. Run 2 (warm) must find none of them: the
 * checkpoint was restored when run 1 ended, and /tmp (a separate disk on a
 * Sprite, which the restore does not reset) was emptied before that. Both
 * runs print their timings.
 *
 * No repository is involved: a stand-in for the clone wrapper only starts the
 * setup wrapper and provider entrypoint. A full task run (clone, agent, result
 * ref) on real Sprites is the maintainer's three-agent E2E.
 */
const token = process.env.PROPR_SPRITES_LIVE_TOKEN?.trim();

const LEFTOVERS = [
    '/home/node/workspace/propr-live-leftover', '/home/node/.propr-live-leftover', '/tmp/propr-live-leftover', '/var/tmp/propr-live-leftover',
    '/dev/shm/propr-live-leftover', '/tmp/claude-logs/propr-live-leftover', '/home/node/.claude/projects/propr-live-leftover',
    // /tmp is not covered by a Sprite's checkpoint: these are gone only because the launcher emptied it before the restore.
    '/tmp/propr-live-nested/deeper/leftover', '/tmp/.propr-live-hidden', '/var/lib/propr/run/propr-live-leftover',
];

test('real Sprite: pinned CLIs, unprivileged agent, credential export, and a clean checkpoint between runs', {
    skip: token ? false : 'set PROPR_SPRITES_LIVE_TOKEN to run the live Sprites check',
    timeout: 40 * 60_000,
}, async () => {
    const { SpritesRuntime } = await import('../packages/core/src/agents/runtime/spritesRuntime.ts');
    const { readSpritesCliPins } = await import('../packages/core/src/agents/runtime/sprites/spritesSetup.ts');
    const { AgentRunSpecBuilder, agentRunNetwork } = await import('../packages/core/src/agents/runtime/agentRunSpec.ts');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-sprites-live-'));
    const store = path.join(root, 'claude');
    fs.mkdirSync(store);
    fs.writeFileSync(path.join(store, '.credentials.json'), 'live-token-v1', { mode: 0o600 });
    const environment: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: root,
        PROPR_SPRITES_TOKEN: token,
        PROPR_SPRITES_NAME_PREFIX: process.env.PROPR_SPRITES_LIVE_PREFIX || 'propr-live',
        PROPR_SPRITES_WORKER_ID: 'live',
        PROPR_SPRITES_MAX_SPRITES: '1',
        PROPR_SPRITES_STATE_DIR: path.join(root, 'state'),
        ...(process.env.PROPR_SPRITES_LIVE_REGION ? { PROPR_SPRITES_REGION: process.env.PROPR_SPRITES_LIVE_REGION } : {}),
    };
    const runtime = new SpritesRuntime({ environment });
    const pins = readSpritesCliPins();
    const spriteName = `${environment.PROPR_SPRITES_NAME_PREFIX}-live-0`;

    const run = async (name: string, script: string) => {
        const spec = new AgentRunSpecBuilder({
            agentType: 'claude', image: 'propr/agent:live', name: `${name}-${Date.now()}`, stdin: true, user: '0:0',
            network: agentRunNetwork('bridge'),
            workspace: { hostPath: '/tmp/unused', containerPath: '/home/node/workspace', readOnly: false },
        })
            .bind('/tmp/claude-logs', '/tmp/claude-logs', false, 'logs')
            .credentialBind(store, '/home/node/.claude', false, { provider: 'claude', store: 'config', perRun: true })
            .env('PROPR_SPRITES_TOKEN').env('PROPR_LIVE_CHECK', '1')
            .command('/bin/bash', '-c', script, 'propr-live').build();
        // Stand-ins for the clone and setup wrappers: they only start the next stage, as root, like the real ones.
        spec.repoSetup = { agentType: 'claude', shell: '/bin/bash', script: 'exec "$0" "$@"', providerEntrypoint: '/home/node/claude-entrypoint.sh', env: [] };
        spec.workspace = {
            ...spec.workspace, mode: 'clone',
            clone: { remote: 'https://github.com/example/none.git', baseRef: 'none', baseCommit: 'none', branch: 'none', resultDir: '/tmp/propr-workspace-result', script: 'exec /bin/bash -lc "$0" "$@"' },
        };
        const handle = runtime.start(spec, { timeout: 30 * 60_000, stdinData: 'prompt from stdin\n' });
        try {
            const result = await handle.wait();
            await handle.release();
            console.log(JSON.stringify({ run: name, exitCode: result.exitCode, timings: handle.timings }));
            return { result, timings: handle.timings };
        } finally {
            await handle.release();
        }
    };

    try {
        const first = await run('cold', `
            set -u
            echo "user=$(id -un) uid=$(id -u) home=$HOME"
            if sudo -n true 2>/dev/null; then echo "sudo=yes"; else echo "sudo=no"; fi
            if ls /opt/propr/run >/dev/null 2>&1; then echo "run-dir=readable"; else echo "run-dir=hidden"; fi
            echo "claude=$(claude --version | head -n 1)"
            echo "codex=$(codex --version | head -n 1)"
            echo "agy=$(agy --version | head -n 1)"
            echo "stdin=$(cat)"
            echo "token-env=\${PROPR_SPRITES_TOKEN:-unset}"
            echo "tmpdir=$TMPDIR made=$(dirname "$(mktemp)")"
            echo "logs=$(readlink -f /tmp/claude-logs)"
            echo "received=$(cat /home/node/.claude/.credentials.json)"
            printf 'live-token-v2' > /home/node/.claude/.credentials.json
            for file in ${LEFTOVERS.join(' ')}; do mkdir -p "$(dirname "$file")" 2>/dev/null; echo left > "$file" 2>/dev/null || echo "cannot-leave=$file"; done
            (setsid sleep 600 >/dev/null 2>&1 &)
            echo done
        `);
        assert.equal(first.result.exitCode, 0, first.result.stderr);
        const output = first.result.stdout;
        assert.match(output, /user=node uid=[1-9]\d* home=\/home\/node/);
        assert.match(output, /sudo=no/);
        assert.match(output, /run-dir=hidden/);
        assert.ok(output.includes(pins.CLAUDE_CLI_VERSION), 'the pinned Claude Code CLI runs');
        assert.ok(output.includes(pins.CODEX_CLI_VERSION), 'the pinned Codex CLI runs');
        assert.ok(output.includes(`agy=${pins.ANTIGRAVITY_CLI_VERSION}`), 'the pinned Antigravity CLI runs');
        assert.match(output, /stdin=prompt from stdin/);
        assert.match(output, /token-env=unset/);
        // Scratch and the log directory are on the checkpointed root, not on /tmp.
        assert.match(output, /tmpdir=\/var\/lib\/propr\/run made=\/var\/lib\/propr\/run$/m);
        assert.match(output, /logs=\/var\/lib\/propr\/mounts\/\d+$/m);
        assert.match(output, /received=live-token-v1/);
        assert.ok(!output.includes(token!) && !first.result.stderr.includes(token!));
        assert.equal(fs.readFileSync(path.join(store, '.credentials.json'), 'utf8'), 'live-token-v2', 'the refreshed credential returned through the export');
        assert.equal(first.timings.recycleAction, 'restored');

        const second = await run('warm', `
            for file in ${LEFTOVERS.join(' ')}; do if [ -e "$file" ]; then echo "survived=$file"; fi; done
            for entry in /tmp/* /tmp/.[!.]*; do
                if [ -e "$entry" ] && [ "$entry" != /tmp/claude-logs ] && [ -O "$entry" ]; then echo "survived=$entry"; fi
            done
            if pgrep -u "$(id -u)" -x sleep >/dev/null 2>&1; then echo "survived=process"; fi
            echo "received=$(cat /home/node/.claude/.credentials.json)"
            echo checked
        `);
        assert.equal(second.result.exitCode, 0, second.result.stderr);
        assert.doesNotMatch(second.result.stdout, /survived=/, 'nothing of run 1 reached run 2');
        assert.match(second.result.stdout, /received=live-token-v2/);
        assert.match(second.result.stdout, /checked/);
        assert.equal(second.timings.provisionMs, undefined, 'the warm run did not provision');
        assert.equal(second.timings.restoreMs, undefined, 'the warm run did not restore before starting');
    } finally {
        if (process.env.PROPR_SPRITES_LIVE_KEEP !== '1') {
            await (await runtime.client()).deleteSprite(spriteName).catch(() => undefined);
        }
        fs.rmSync(root, { recursive: true, force: true });
    }
});
