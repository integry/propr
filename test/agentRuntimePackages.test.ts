import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import {
    buildAgentRuntimeDockerfile,
    getAgentRuntimeImageTag,
    validateAgentRuntimePackages
} from '../packages/core/src/agents/runtime/agentRuntimePackages.js';
import { resolveConfiguredAgentBaseImage } from '../packages/core/src/agents/version/versionService.js';
import { closeConnection } from '../packages/core/src/db/connection.js';

after(async () => closeConnection());

describe('agent runtime package profiles', () => {
    test('normalizes names, preserves pinned versions, deduplicates, and sorts', () => {
        const result = validateAgentRuntimePackages([
            ' Chromium ',
            'ffmpeg',
            'chromium',
            'libgtk-3-0:AMD64=3.24.38-2~Deb12u3'
        ]);

        assert.equal(result.valid, true);
        assert.deepEqual(result.packages, [
            'chromium',
            'ffmpeg',
            'libgtk-3-0:amd64=3.24.38-2~Deb12u3'
        ]);
    });

    test('rejects shell syntax, apt options, and malformed values', () => {
        const result = validateAgentRuntimePackages([
            'chromium;id',
            '--allow-unauthenticated',
            'curl $(whoami)',
            '',
            42
        ]);

        assert.equal(result.valid, false);
        assert.match(result.errors.join('\n'), /chromium;id/);
        assert.match(result.errors.join('\n'), /--allow-unauthenticated/);
        assert.match(result.errors.join('\n'), /curl \$\(whoami\)/);
    });

    test('generates a package-only Dockerfile and restores the base user', () => {
        const dockerfile = buildAgentRuntimeDockerfile(
            'propr/agent-codex:1.2.3',
            ['chromium', 'ffmpeg'],
            'node'
        );

        assert.match(dockerfile, /^FROM propr\/agent-codex:1\.2\.3/m);
        assert.match(dockerfile, /LABEL dev\.propr\.agent-runtime="true"/);
        assert.match(dockerfile, /USER root/);
        assert.match(dockerfile, /apt-get install -y --no-install-recommends/);
        assert.match(dockerfile, /chromium/);
        assert.match(dockerfile, /ffmpeg/);
        assert.match(dockerfile, /rm -rf \/var\/lib\/apt\/lists\/\*/);
        assert.match(dockerfile, /USER node\n$/);
        assert.doesNotMatch(dockerfile, /^\+/m);
    });

    test('generates an apk install layer for Alpine-based custom images', () => {
        const dockerfile = buildAgentRuntimeDockerfile(
            'custom/agent:alpine',
            ['chromium', 'ffmpeg'],
            'node',
            'apk'
        );

        assert.match(dockerfile, /RUN apk add --no-cache chromium ffmpeg/);
        assert.doesNotMatch(dockerfile, /apt-get/);
        assert.match(dockerfile, /USER node\n$/);
    });

    test('resolves stale managed hashes to the current build inputs', () => {
        const resolved = resolveConfiguredAgentBaseImage({
            type: 'claude',
            dockerImage: 'propr/agent-claude:2.1.170-b41d7a',
            cliVersionType: 'default',
            cliVersionResolved: '2.1.170'
        }, process.cwd());

        assert.match(resolved, /^propr\/agent-claude:2\.1\.170-[0-9a-f]{6}$/);
        assert.notEqual(resolved, 'propr/agent-claude:2.1.170-b41d7a');
    });

    test('runtime tags are stable and change with the base digest or packages', () => {
        const first = getAgentRuntimeImageTag('propr/agent-codex:latest', 'sha256:one', ['chromium']);
        assert.equal(first, getAgentRuntimeImageTag('propr/agent-codex:latest', 'sha256:one', ['chromium']));
        assert.notEqual(first, getAgentRuntimeImageTag('propr/agent-codex:latest', 'sha256:two', ['chromium']));
        assert.notEqual(first, getAgentRuntimeImageTag('propr/agent-codex:latest', 'sha256:one', ['chromium', 'ffmpeg']));
        assert.notEqual(
            getAgentRuntimeImageTag('propr/agent-codex:latest', 'sha256:one', ['chromium'], 'installation-a'),
            getAgentRuntimeImageTag('propr/agent-codex:latest', 'sha256:one', ['chromium'], 'installation-b')
        );
    });
});
