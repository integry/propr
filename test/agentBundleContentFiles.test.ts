import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_BUNDLE_CONTENT_FILES } from '../packages/core/src/agents/version/types.js';

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
