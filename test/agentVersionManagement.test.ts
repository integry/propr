import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert';
import { AGENT_DEFAULTS } from '@propr/shared';
import { AGENT_IMAGE_NAMES, AGENT_TYPES, DEFAULT_AGENT_DOCKER_IMAGES, VERSIONED_AGENT_IMAGE_NAMES } from '../packages/core/src/agents/constants.js';
import { CONTAINER_CONFIG_PATHS } from '../packages/core/src/agents/types.js';
import { AGENT_DEFAULT_VERSIONS, AGENT_NPM_PACKAGES, AGENT_NPM_TAGS } from '../packages/core/src/agents/version/types.js';
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
        assert.strictEqual(AGENT_NPM_PACKAGES.opencode, 'opencode-ai');
        assert.deepStrictEqual(AGENT_NPM_TAGS.opencode, ['latest', 'beta', 'dev']);
        assert.strictEqual(AGENT_DEFAULTS.opencode.defaultCliVersion, '1.15.12');
        assert.strictEqual(AGENT_DEFAULT_VERSIONS.opencode, '1.15.12');
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
            generateImageTag('opencode', '1.15.12', 'abc123'),
            'propr-opencode:1.15.12-abc123'
        );
    });

    test('returns OpenCode package tags and default version metadata', async () => {
        globalThis.fetch = (async () => new Response(JSON.stringify({
            name: 'opencode-ai',
            'dist-tags': { latest: '1.15.12', beta: '1.16.0-beta.1', dev: '1.16.0-dev.1' },
            versions: {
                '1.15.12': { name: 'opencode-ai', version: '1.15.12' },
                '1.15.11': { name: 'opencode-ai', version: '1.15.11' }
            },
            time: {
                '1.15.12': '2026-05-29T00:00:00.000Z',
                '1.15.11': '2026-05-28T00:00:00.000Z'
            }
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
        })) as typeof fetch;

        const metadata = await getAvailableVersions('opencode');

        assert.strictEqual(metadata.agentType, 'opencode');
        assert.strictEqual(metadata.packageName, 'opencode-ai');
        assert.strictEqual(metadata.defaultVersion, '1.15.12');
        assert.deepStrictEqual(metadata.availableTags, [
            { tag: 'latest', version: '1.15.12' },
            { tag: 'beta', version: '1.16.0-beta.1' },
            { tag: 'dev', version: '1.16.0-dev.1' }
        ]);
    });
});
