import { describe, test } from 'node:test';
import assert from 'node:assert';
import { wrapDockerRunArgsWithRepoSetup } from '../packages/core/src/claude/docker/repoSetupWrapper.js';

describe('wrapDockerRunArgsWithRepoSetup', () => {
    test('wraps docker command with repo setup hook and original entrypoint', () => {
        const wrapped = wrapDockerRunArgsWithRepoSetup([
            'run', '--rm',
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
        assert.match(wrapperScript, /sudo -E -u node -H \/bin\/bash/);
        assert.match(wrapperScript, /<\/dev\/null >&2/);
        assert.match(wrapperScript, /exec "\$entrypoint" "\$@"/);
    });

    test('adds setup environment for the selected agent type', () => {
        const wrapped = wrapDockerRunArgsWithRepoSetup([
            'run', '--rm',
            'propr/agent-gemini:latest',
            'gemini', '--yolo'
        ], 'propr/agent-gemini:latest', 'gemini');

        assert.ok(wrapped.includes('PROPR_AGENT_TYPE=gemini'));
        assert.ok(wrapped.includes('PROPR_WORKSPACE=/home/node/workspace'));
        assert.ok(wrapped.includes('PROPR_CACHE_DIR=/tmp/git-processor/propr-cache/gemini'));

        const imageIndex = wrapped.indexOf('propr/agent-gemini:latest');
        assert.strictEqual(wrapped[imageIndex + 3], '/home/node/gemini-entrypoint.sh');
    });

    test('throws when the configured docker image cannot be found', () => {
        assert.throws(() => wrapDockerRunArgsWithRepoSetup([
            'run', '--rm', 'other-image:latest', 'claude'
        ], 'propr/agent-claude:latest', 'claude'), /Docker image 'propr\/agent-claude:latest' was not found/);
    });
});

