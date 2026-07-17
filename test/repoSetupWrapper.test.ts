import { describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { wrapDockerRunArgsWithRepoSetup } from '../packages/core/src/claude/docker/repoSetupWrapper.js';

describe('wrapDockerRunArgsWithRepoSetup', () => {
    test('wraps docker command with repo setup hook and original entrypoint', () => {
        const wrapped = wrapDockerRunArgsWithRepoSetup([
            'run', '--rm',
            '--security-opt', 'no-new-privileges',
            '-v', '/tmp/worktree:/home/node/workspace:rw',
            'propr/agent:latest',
            'codex', 'exec', '--json', '-'
        ], 'propr/agent:latest', 'codex');

        const imageIndex = wrapped.indexOf('propr/agent:latest');
        assert.ok(imageIndex > -1);
        assert.ok(wrapped.indexOf('--entrypoint') < imageIndex);
        assert.deepStrictEqual(wrapped.slice(imageIndex + 1, imageIndex + 3), ['-lc', wrapped[imageIndex + 2]]);
        assert.strictEqual(wrapped[imageIndex + 3], '/home/node/codex-entrypoint.sh');
        assert.deepStrictEqual(wrapped.slice(imageIndex + 4), ['codex', 'exec', '--json', '-']);

        const wrapperScript = wrapped[imageIndex + 2];
        assert.match(wrapperScript, /\.propr\/setup\.sh/);
        assert.match(wrapperScript, /\[ "\$\(id -u\)" = "0" \][\s\S]*su-exec node env HOME=\/home\/node \/bin\/bash/);
        assert.match(wrapperScript, /<\/dev\/null >&2/);
        assert.match(wrapperScript, /ProPR repo setup hook failed with exit code/);
        assert.match(wrapperScript, /PROPR_REPO_SETUP_STRICT/);
        assert.match(wrapperScript, /Continuing so the agent can inspect and repair/);
        assert.match(wrapperScript, /exec "\$entrypoint" "\$@"/);
        assert.ok(wrapped.includes('no-new-privileges'));
    });

    test('preserves inline no-new-privileges before repo setup', () => {
        const wrapped = wrapDockerRunArgsWithRepoSetup([
            'run', '--rm',
            '--security-opt=no-new-privileges',
            '--security-opt', 'seccomp=unconfined',
            'propr/agent:latest',
            'codex', 'exec', '-'
        ], 'propr/agent:latest', 'codex');

        assert.ok(wrapped.includes('--security-opt=no-new-privileges'));
        assert.deepStrictEqual(
            wrapped.slice(wrapped.indexOf('--security-opt'), wrapped.indexOf('--security-opt') + 2),
            ['--security-opt', 'seccomp=unconfined']
        );
    });

    test('preserves docker boolean no-new-privileges forms before repo setup', () => {
        const wrapped = wrapDockerRunArgsWithRepoSetup([
            'run', '--rm',
            '--security-opt', 'no-new-privileges:true',
            '--security-opt=no-new-privileges:false',
            '--security-opt', 'seccomp=unconfined',
            'propr/agent:latest',
            'codex', 'exec', '-'
        ], 'propr/agent:latest', 'codex');

        assert.ok(wrapped.includes('no-new-privileges:true'));
        assert.ok(wrapped.includes('--security-opt=no-new-privileges:false'));
        assert.deepStrictEqual(
            wrapped.slice(wrapped.indexOf('--security-opt'), wrapped.indexOf('--security-opt') + 2),
            ['--security-opt', 'no-new-privileges:true']
        );
    });

    test('adds setup environment for the selected agent type', () => {
        const wrapped = wrapDockerRunArgsWithRepoSetup([
            'run', '--rm',
            '-e', 'PROPR_REPO_SETUP=0',
            'propr/agent:latest',
            'agy', '--dangerously-skip-permissions'
        ], 'propr/agent:latest', 'antigravity');

        assert.ok(wrapped.includes('PROPR_AGENT_TYPE=antigravity'));
        assert.ok(wrapped.includes('PROPR_WORKSPACE=/home/node/workspace'));
        assert.ok(wrapped.includes('PROPR_CACHE_DIR=/tmp/git-processor/propr-cache/antigravity'));
        assert.ok(wrapped.includes('PROPR_REPO_SETUP=0'));
        assert.ok(wrapped.includes('GIT_AUTHOR_NAME=ProPR Antigravity Bot'));
        assert.ok(wrapped.includes('GIT_AUTHOR_EMAIL=antigravity-bot@propr.dev'));
        assert.ok(wrapped.includes('GIT_COMMITTER_NAME=ProPR Antigravity Bot'));
        assert.ok(wrapped.includes('GIT_COMMITTER_EMAIL=antigravity-bot@propr.dev'));

        const imageIndex = wrapped.indexOf('propr/agent:latest');
        assert.strictEqual(wrapped[imageIndex + 3], '/home/node/antigravity-entrypoint.sh');
    });

    test('maps Vibe to the Vibe entrypoint', () => {
        const wrapped = wrapDockerRunArgsWithRepoSetup([
            'run', '--rm',
            'propr/agent:latest',
            'vibe', '--prompt', 'Analyze the codebase'
        ], 'propr/agent:latest', 'vibe');

        assert.ok(wrapped.includes('PROPR_AGENT_TYPE=vibe'));
        assert.ok(wrapped.includes('PROPR_CACHE_DIR=/tmp/git-processor/propr-cache/vibe'));

        const imageIndex = wrapped.indexOf('propr/agent:latest');
        assert.strictEqual(wrapped[imageIndex + 3], '/home/node/vibe-entrypoint.sh');
        assert.deepStrictEqual(wrapped.slice(imageIndex + 4), ['vibe', '--prompt', 'Analyze the codebase']);
    });

    test('agent entrypoints do not require sudo under Docker no-new-privileges', () => {
        for (const scriptPath of [
            'scripts/claude-entrypoint.sh',
            'scripts/codex-entrypoint.sh',
            'scripts/antigravity-entrypoint.sh'
        ]) {
            const script = fs.readFileSync(scriptPath, 'utf8');
            const executableLines = script
                .split('\n')
                .filter(line => !line.trim().startsWith('#'))
                .join('\n');
            assert.doesNotMatch(executableLines, /\bsudo\b/, `${scriptPath} should not invoke sudo`);
            assert.match(script, /exec su-exec node env HOME=\/home\/node "\$@"/);
        }
    });

    test('throws when the configured docker image cannot be found', () => {
        assert.throws(() => wrapDockerRunArgsWithRepoSetup([
            'run', '--rm', 'other-image:latest', 'claude'
        ], 'propr/agent:latest', 'claude'), /Docker image 'propr\/agent:latest' was not found/);
    });
});
