import { describe, test } from 'node:test';
import assert from 'node:assert';
import { wrapDockerRunArgsWithRepoSetup } from '../packages/core/src/claude/docker/repoSetupWrapper.js';

describe('wrapDockerRunArgsWithRepoSetup', () => {
    test('wraps docker command with repo setup hook and original entrypoint', () => {
        const wrapped = wrapDockerRunArgsWithRepoSetup([
            'run', '--rm',
            '--security-opt', 'no-new-privileges',
            '-v', '/tmp/worktree:/home/node/workspace:rw',
            'propr/agent-codex:latest',
            'codex', 'exec', '--json', '-'
        ], 'propr/agent-codex:latest', 'codex');

        const imageIndex = wrapped.indexOf('propr/agent-codex:latest');
        assert.ok(imageIndex > -1);
        assert.ok(wrapped.indexOf('--entrypoint') < imageIndex);
        assert.deepStrictEqual(wrapped.slice(imageIndex + 1, imageIndex + 3), ['-lc', wrapped[imageIndex + 2]]);
        assert.strictEqual(wrapped[imageIndex + 3], '/home/node/codex-entrypoint.sh');
        assert.deepStrictEqual(wrapped.slice(imageIndex + 4), ['codex', 'exec', '--json', '-']);

        const wrapperScript = wrapped[imageIndex + 2];
        assert.match(wrapperScript, /\.propr\/setup\.sh/);
        assert.match(wrapperScript, /\[ "\$\(id -u\)" = "0" \][\s\S]*sudo -E -u node -H \/bin\/bash/);
        assert.match(wrapperScript, /<\/dev\/null >&2/);
        assert.match(wrapperScript, /ProPR repo setup hook failed with exit code/);
        assert.match(wrapperScript, /PROPR_REPO_SETUP_STRICT/);
        assert.match(wrapperScript, /Continuing so the agent can inspect and repair/);
        assert.match(wrapperScript, /exec setpriv --no-new-privs "\$entrypoint" "\$@"/);
        assert.ok(!wrapped.includes('no-new-privileges'));
    });

    test('removes inline no-new-privileges before repo setup', () => {
        const wrapped = wrapDockerRunArgsWithRepoSetup([
            'run', '--rm',
            '--security-opt=no-new-privileges',
            '--security-opt', 'seccomp=unconfined',
            'propr/agent-codex:latest',
            'codex', 'exec', '-'
        ], 'propr/agent-codex:latest', 'codex');

        assert.ok(!wrapped.includes('--security-opt=no-new-privileges'));
        assert.deepStrictEqual(
            wrapped.slice(wrapped.indexOf('--security-opt'), wrapped.indexOf('--security-opt') + 2),
            ['--security-opt', 'seccomp=unconfined']
        );
    });

    test('adds setup environment for the selected agent type', () => {
        const wrapped = wrapDockerRunArgsWithRepoSetup([
            'run', '--rm',
            '-e', 'PROPR_REPO_SETUP=0',
            'propr/agent-antigravity:latest',
            'agy', '--dangerously-skip-permissions'
        ], 'propr/agent-antigravity:latest', 'antigravity');

        assert.ok(wrapped.includes('PROPR_AGENT_TYPE=antigravity'));
        assert.ok(wrapped.includes('PROPR_WORKSPACE=/home/node/workspace'));
        assert.ok(wrapped.includes('PROPR_CACHE_DIR=/tmp/git-processor/propr-cache/antigravity'));
        assert.ok(wrapped.includes('PROPR_REPO_SETUP=0'));

        const imageIndex = wrapped.indexOf('propr/agent-antigravity:latest');
        assert.strictEqual(wrapped[imageIndex + 3], '/home/node/antigravity-entrypoint.sh');
    });

    test('maps Vibe to the Vibe entrypoint', () => {
        const wrapped = wrapDockerRunArgsWithRepoSetup([
            'run', '--rm',
            'propr/agent-vibe:latest',
            'vibe', '--prompt', 'Analyze the codebase'
        ], 'propr/agent-vibe:latest', 'vibe');

        assert.ok(wrapped.includes('PROPR_AGENT_TYPE=vibe'));
        assert.ok(wrapped.includes('PROPR_CACHE_DIR=/tmp/git-processor/propr-cache/vibe'));

        const imageIndex = wrapped.indexOf('propr/agent-vibe:latest');
        assert.strictEqual(wrapped[imageIndex + 3], '/home/node/vibe-entrypoint.sh');
        assert.deepStrictEqual(wrapped.slice(imageIndex + 4), ['vibe', '--prompt', 'Analyze the codebase']);
    });

    test('throws when the configured docker image cannot be found', () => {
        assert.throws(() => wrapDockerRunArgsWithRepoSetup([
            'run', '--rm', 'other-image:latest', 'claude'
        ], 'propr/agent-claude:latest', 'claude'), /Docker image 'propr\/agent-claude:latest' was not found/);
    });
});
