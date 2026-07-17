import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { AGENT_DEFAULTS } from '@propr/shared';
import { AGENT_IMAGE_NAME, AGENT_TYPES, DEFAULT_AGENT_DOCKER_IMAGES } from '../packages/core/src/agents/constants.js';
import { CONTAINER_CONFIG_PATHS } from '../packages/core/src/agents/types.js';
import { AGENT_CLI_PACKAGES, AGENT_CLI_TAGS, AGENT_DEFAULT_VERSIONS } from '../packages/core/src/agents/version/types.js';
import { generateAgentBundleImageTag, getAvailableVersions, getDefaultAgentCliVersionMatrix, resolveVersion } from '../packages/core/src/agents/version/versionService.js';
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
        assert.strictEqual(AGENT_DEFAULTS.opencode.defaultCliVersion, '1.18.2');
        assert.strictEqual(AGENT_DEFAULT_VERSIONS.opencode, '1.18.2');
        assert.strictEqual(AGENT_IMAGE_NAME, 'propr/agent');
        assert.strictEqual(DEFAULT_AGENT_DOCKER_IMAGES.opencode, 'propr/agent:latest');
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

    test('generates unified bundle image tags', () => {
        const versions = getDefaultAgentCliVersionMatrix();
        versions.opencode = '1.18.2';
        assert.match(generateAgentBundleImageTag(versions, 'abc123'), /^propr\/agent:bundle-[0-9a-f]{12}-abc123$/);
    });

    test('keeps agent image build fallbacks aligned with core metadata', () => {
        const agentDockerfile = fs.readFileSync('Dockerfile.agent', 'utf8');
        const buildScript = fs.readFileSync('scripts/build-images.sh', 'utf8');

        assert.match(agentDockerfile, new RegExp(`^ARG OPENCODE_CLI_VERSION=${AGENT_DEFAULT_VERSIONS.opencode}$`, 'm'));
        assert.match(agentDockerfile, new RegExp(`^ARG VIBE_CLI_VERSION=${AGENT_DEFAULT_VERSIONS.vibe}$`, 'm'));
        assert.match(buildScript, new RegExp(`^CLAUDE_CLI_VERSION="\\$\\{CLAUDE_CLI_VERSION:-${AGENT_DEFAULT_VERSIONS.claude}\\}"$`, 'm'));
        assert.match(buildScript, new RegExp(`^CODEX_CLI_VERSION="\\$\\{CODEX_CLI_VERSION:-${AGENT_DEFAULT_VERSIONS.codex}\\}"$`, 'm'));
    });

    test('uses Debian/glibc package management for the unified agent image', () => {
        const agentDockerfile = fs.readFileSync('Dockerfile.agent', 'utf8');

        assert.match(agentDockerfile, /^ARG AGENT_PLATFORM=linux\/amd64$/m);
        assert.match(agentDockerfile, /^FROM --platform=\$\{AGENT_PLATFORM\} node:22-bookworm-slim AS agent-base$/m);
        assert.match(agentDockerfile, /https:\/\/cli\.github\.com\/packages stable main/);
        assert.match(agentDockerfile, /^ARG GITHUBCLI_KEYRING_SHA256=[0-9a-f]{64}$/m);
        assert.match(agentDockerfile, /^ARG CURL_VERSION_PREFIX=/m);
        assert.match(agentDockerfile, /apt_version_arg\(\) /);
        assert.match(agentDockerfile, /apt_version_arg util-linux "\$UTIL_LINUX_VERSION_PREFIX"/);
        assert.match(agentDockerfile, /setpriv --version/);
        assert.match(agentDockerfile, /FROM agent-base AS claude-cli/);
        assert.match(agentDockerfile, /FROM agent-base AS codex-cli/);
        assert.match(agentDockerfile, /FROM agent-base AS antigravity-cli/);
        assert.match(agentDockerfile, /FROM agent-base AS opencode-cli/);
        assert.match(agentDockerfile, /FROM agent-base AS vibe-cli/);
        assert.doesNotMatch(agentDockerfile, /\bapk add\b/);
    });

    test('shared agent entrypoint recognizes raw dispatcher commands', () => {
        const entrypoint = fs.readFileSync('scripts/agent-entrypoint.sh', 'utf8');
        const vibeAgent = fs.readFileSync('packages/core/src/agents/impl/VibeAgent.ts', 'utf8');

        assert.match(entrypoint, /opencode-run\|\/usr\/local\/bin\/opencode-run\) agent_type=opencode/);
        assert.match(entrypoint, /\/home\/node\/antigravity-entrypoint\.sh/);
        assert.match(entrypoint, /exec "\$1" "\$\{@:2\}"/);
        assert.match(entrypoint, /bash\|sh\|\/bin\/bash\|\/bin\/sh/);
        assert.match(vibeAgent, /PROPR_AGENT_TYPE=vibe/);
    });

    test('records proprietary installer provenance in the unified agent image', () => {
        const agentDockerfile = fs.readFileSync('Dockerfile.agent', 'utf8');

        assert.match(agentDockerfile, /antigravity-installer\.sha256/);
        assert.match(agentDockerfile, /antigravity-cli\.version/);
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
        assert.strictEqual(metadata.defaultVersion, '1.18.2');
        assert.deepStrictEqual(metadata.availableTags, [
            { tag: 'latest', version: '1.17.10' },
            { tag: 'beta', version: '1.18.0-beta.1' },
            { tag: 'dev', version: '1.18.0-dev.1' }
        ]);
    });
});
