import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { AGENT_DEFAULTS } from '@propr/shared';
import { AGENT_IMAGE_NAMES, AGENT_TYPES, DEFAULT_AGENT_DOCKER_IMAGES, VERSIONED_AGENT_IMAGE_NAMES } from '../packages/core/src/agents/constants.js';
import { CONTAINER_CONFIG_PATHS } from '../packages/core/src/agents/types.js';
import { AGENT_CLI_PACKAGES, AGENT_CLI_TAGS, AGENT_DEFAULT_VERSIONS } from '../packages/core/src/agents/version/types.js';
import { generateImageTag, getAvailableVersions, resolveVersion } from '../packages/core/src/agents/version/versionService.js';
import { clearNpmCache } from '../packages/core/src/agents/version/npmClient.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
    clearNpmCache();
});

describe('agent version management', () => {
    test('includes OpenCode in core agent configuration constants', () => {
        assert.ok(AGENT_TYPES.includes('opencode'));
        assert.strictEqual(CONTAINER_CONFIG_PATHS.opencode, '/home/node/.config/opencode');
        assert.strictEqual(AGENT_DEFAULTS.opencode.configPath, '~/.config/opencode');
        assert.strictEqual(AGENT_DEFAULTS.opencode.npmPackage, 'opencode-ai');
        assert.strictEqual(AGENT_CLI_PACKAGES.opencode, 'opencode-ai');
        assert.deepStrictEqual(AGENT_CLI_TAGS.opencode, ['latest', 'beta', 'dev']);
        assert.strictEqual(AGENT_DEFAULTS.opencode.defaultCliVersion, '1.17.10');
        assert.strictEqual(AGENT_DEFAULT_VERSIONS.opencode, '1.17.10');
        assert.strictEqual(AGENT_IMAGE_NAMES.opencode, 'propr/agent-opencode');
        assert.strictEqual(DEFAULT_AGENT_DOCKER_IMAGES.opencode, 'propr/agent-opencode:latest');
        assert.strictEqual(VERSIONED_AGENT_IMAGE_NAMES.opencode, 'propr-opencode');
    });

    test('resolves OpenCode dist tags against the opencode-ai npm package', async () => {
        let fetchedUrl = '';
        globalThis.fetch = (async (input: string | URL | Request) => {
            fetchedUrl = input.toString();
            return new Response(JSON.stringify({
                name: 'opencode-ai',
                'dist-tags': { latest: '9.8.7' },
                versions: { '9.8.7': { name: 'opencode-ai', version: '9.8.7' } },
                time: { '9.8.7': '2026-05-29T00:00:00.000Z' }
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
        }) as typeof fetch;

        const resolved = await resolveVersion('opencode', 'tag', 'latest');

        assert.strictEqual(resolved, '9.8.7');
        assert.match(fetchedUrl, /\/opencode-ai$/);
    });

    test('generates OpenCode-specific image tags', () => {
        assert.strictEqual(
            generateImageTag('opencode', '1.17.10', 'abc123'),
            'propr-opencode:1.17.10-abc123'
        );
    });

    test('keeps agent image build fallbacks aligned with core metadata', () => {
        const opencodeDockerfile = fs.readFileSync('Dockerfile.opencode', 'utf8');
        const vibeDockerfile = fs.readFileSync('Dockerfile.vibe', 'utf8');
        const buildScript = fs.readFileSync('scripts/build-images.sh', 'utf8');

        assert.match(opencodeDockerfile, new RegExp(`^ARG CLI_VERSION=${AGENT_DEFAULT_VERSIONS.opencode}$`, 'm'));
        assert.match(vibeDockerfile, new RegExp(`^ARG CLI_VERSION=${AGENT_DEFAULT_VERSIONS.vibe}$`, 'm'));
        assert.match(buildScript, new RegExp(`^CLAUDE_CLI_VERSION="\\$\\{CLAUDE_CLI_VERSION:-${AGENT_DEFAULT_VERSIONS.claude}\\}"$`, 'm'));
        assert.match(buildScript, new RegExp(`^CODEX_CLI_VERSION="\\$\\{CODEX_CLI_VERSION:-${AGENT_DEFAULT_VERSIONS.codex}\\}"$`, 'm'));
    });

    test('uses Debian/glibc package management for shared agent images', () => {
        const agentBaseDockerfile = fs.readFileSync('docker/Dockerfile.agent-base', 'utf8');
        const codexDockerfile = fs.readFileSync('Dockerfile.codex', 'utf8');
        const opencodeDockerfile = fs.readFileSync('Dockerfile.opencode', 'utf8');
        const vibeDockerfile = fs.readFileSync('Dockerfile.vibe', 'utf8');

        assert.match(agentBaseDockerfile, /^FROM node:20-slim$/m);
        assert.match(agentBaseDockerfile, /apt-get install -y --no-install-recommends[\s\S]*\bgh\b[\s\S]*\btini\b/);
        assert.match(codexDockerfile, /apt-get install -y --no-install-recommends ripgrep/);
        assert.match(opencodeDockerfile, /apt-get install -y --no-install-recommends gosu/);
        assert.match(vibeDockerfile, /apt-get install -y --no-install-recommends bash python3 sudo gosu/);

        for (const dockerfile of [agentBaseDockerfile, codexDockerfile, opencodeDockerfile, vibeDockerfile]) {
            assert.doesNotMatch(dockerfile, /\bapk add\b/);
        }
    });

    test('returns OpenCode package tags and default version metadata', async () => {
        globalThis.fetch = (async () => new Response(JSON.stringify({
            name: 'opencode-ai',
            'dist-tags': { latest: '1.17.10', beta: '1.18.0-beta.1', dev: '1.18.0-dev.1' },
            versions: {
                '1.17.10': { name: 'opencode-ai', version: '1.17.10' },
                '1.17.9': { name: 'opencode-ai', version: '1.17.9' }
            },
            time: {
                '1.17.10': '2026-06-25T00:00:00.000Z',
                '1.17.9': '2026-06-24T00:00:00.000Z'
            }
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
        })) as typeof fetch;

        const metadata = await getAvailableVersions('opencode');

        assert.strictEqual(metadata.agentType, 'opencode');
        assert.strictEqual(metadata.packageName, 'opencode-ai');
        assert.strictEqual(metadata.defaultVersion, '1.17.10');
        assert.deepStrictEqual(metadata.availableTags, [
            { tag: 'latest', version: '1.17.10' },
            { tag: 'beta', version: '1.18.0-beta.1' },
            { tag: 'dev', version: '1.18.0-dev.1' }
        ]);
    });
});
