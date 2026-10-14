import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_BUNDLE_CONTENT_FILES, AGENT_DEFAULT_VERSIONS } from '../packages/core/src/agents/version/types.js';
import { computeContentHash, generateAgentBundleImageTag } from '../packages/core/src/agents/version/versionService.js';
import { agentBuildContextSources, copyCheckDockerfile } from '../scripts/lib/agent-build-context.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function buildScriptContentFiles(): string[] {
    const buildScript = fs.readFileSync(path.join(repoRoot, 'scripts/build-images.sh'), 'utf8');
    const match = buildScript.match(/AGENT_BUNDLE_CONTENT_FILES=\(\n(?<body>[\s\S]*?)\n\)/);
    assert.ok(match?.groups?.body, 'scripts/build-images.sh must define AGENT_BUNDLE_CONTENT_FILES');
    return match.groups.body
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);
}

describe('agent bundle content files', () => {
    test('build script uses the same content hash inputs as runtime', () => {
        assert.deepEqual(buildScriptContentFiles(), [...AGENT_BUNDLE_CONTENT_FILES]);
    });

    test('build script bundle tag matches the runtime tag algorithm', () => {
        const buildScript = fs.readFileSync(path.join(repoRoot, 'scripts/build-images.sh'), 'utf8');
        const snippetMatch = buildScript.match(/node --input-type=module -e '(?<snippet>[\s\S]*?)'\s*"\$\{AGENT_BUNDLE_CONTENT_FILES\[@\]\}"/);
        assert.ok(snippetMatch?.groups?.snippet, 'scripts/build-images.sh must compute the bundle tag via an inline node snippet');

        const scriptTag = execFileSync(
            process.execPath,
            ['--input-type=module', '-e', snippetMatch.groups.snippet, ...AGENT_BUNDLE_CONTENT_FILES],
            {
                cwd: repoRoot,
                encoding: 'utf8',
                env: {
                    ...process.env,
                    CLAUDE_CLI_VERSION: AGENT_DEFAULT_VERSIONS.claude,
                    CODEX_CLI_VERSION: AGENT_DEFAULT_VERSIONS.codex,
                    ANTIGRAVITY_CLI_VERSION: AGENT_DEFAULT_VERSIONS.antigravity,
                    OPENCODE_CLI_VERSION: AGENT_DEFAULT_VERSIONS.opencode,
                    VIBE_CLI_VERSION: AGENT_DEFAULT_VERSIONS.vibe
                }
            }
        ).trim();

        const runtimeTag = generateAgentBundleImageTag({ ...AGENT_DEFAULT_VERSIONS }, computeContentHash(repoRoot));
        assert.equal(scriptTag, runtimeTag.split(':')[1]);
    });

    test('app production runtime copies every agent bundle content file to its hash input path', () => {
        const dockerfile = fs.readFileSync(path.join(repoRoot, 'docker/Dockerfile.app.prod'), 'utf8');
        const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));
        const runtimeLines = runtimeStage.split('\n').map(line => line.trim());
        for (const file of AGENT_BUNDLE_CONTENT_FILES) {
            assert.ok(
                runtimeLines.includes(`COPY ${file} ./${file}`),
                `docker/Dockerfile.app.prod runtime must copy ${file} to ./${file}`
            );
        }
    });

    test('every build-context source of Dockerfile.agent is an agent bundle content file', () => {
        const sources = agentBuildContextSources(fs.readFileSync(path.join(repoRoot, 'Dockerfile.agent'), 'utf8'));
        assert.ok(sources.includes('scripts/extension-stdio-bridge.mjs'));
        // Together with the runtime-copy test above, this keeps the app image's
        // /usr/src/app a complete context for the worker's custom-bundle build.
        assert.deepEqual(
            [...sources].sort(),
            AGENT_BUNDLE_CONTENT_FILES.filter(file => file !== 'Dockerfile.agent').sort()
        );
    });

    test('build-context parser follows continuations and skips stage copies', () => {
        const dockerfile = [
            'FROM base AS final',
            '# COPY commented/out.sh /nowhere',
            'COPY --from=builder /opt/tool /opt/tool',
            'COPY --chown=node:node \\',
            '    scripts/a.sh \\',
            '    ./scripts/b.sh \\',
            '    /home/node/',
            'ADD --chmod=0755 scripts/c.mjs /opt/c.mjs',
            'COPY --from=other --chown=node:node /x /x'
        ].join('\n');
        assert.deepEqual(agentBuildContextSources(dockerfile), ['scripts/a.sh', 'scripts/b.sh', 'scripts/c.mjs']);
        assert.equal(
            copyCheckDockerfile(dockerfile),
            'FROM scratch\nCOPY scripts/a.sh scripts/b.sh /agent-build-context/0/\nCOPY scripts/c.mjs /agent-build-context/1/\n'
        );
        assert.throws(() => agentBuildContextSources('COPY scripts/*.sh /x/'), /Wildcard/);
    });
});
