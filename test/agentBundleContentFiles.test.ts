import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_BUNDLE_CONTENT_FILES, AGENT_DEFAULT_VERSIONS } from '../packages/core/src/agents/version/types.js';
import { computeContentHash, generateAgentBundleImageTag } from '../packages/core/src/agents/version/versionService.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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

    test('app production image copies every agent bundle content file', () => {
        const dockerfile = fs.readFileSync(path.join(repoRoot, 'docker/Dockerfile.app.prod'), 'utf8');
        for (const file of AGENT_BUNDLE_CONTENT_FILES) {
            assert.match(
                dockerfile,
                new RegExp(`^COPY ${escapeRegex(file)} `, 'm'),
                `docker/Dockerfile.app.prod must copy ${file}`
            );
        }
    });
});
