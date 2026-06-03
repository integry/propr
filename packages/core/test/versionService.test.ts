import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
    generateImageTag,
    getDockerTagComponent,
    resolveVersion
} from '../src/agents/version/index.js';
import { clearPyPiPackageInfoCache } from '../src/agents/version/pypiClient.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
    clearPyPiPackageInfoCache();
});

test('Vibe custom PyPI versions accept arbitrary install specs without registry lookup', async () => {
    globalThis.fetch = async () => {
        throw new Error('fetch should not be called for custom PyPI install specs');
    };

    const spec = 'mistral-vibe @ https://packages.example.test/mistral-vibe-2.13.0b1.tar.gz';

    assert.equal(await resolveVersion('vibe', 'custom', spec), spec);
});

test('Vibe tag versions validate against configured tags before resolving latest', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
        info: { version: '2.12.9' },
        releases: {
            '2.12.9': [{ upload_time_iso_8601: '2026-05-29T00:00:00.000Z' }]
        }
    }));

    assert.equal(await resolveVersion('vibe', 'tag', 'latest'), '2.12.9');
    await assert.rejects(
        () => resolveVersion('vibe', 'tag', 'nightly'),
        /Unknown tag 'nightly'/
    );
});

test('Docker image tags are safe for custom Python install specs', () => {
    const component = getDockerTagComponent('mistral-vibe @ https://packages.example.test/builds/vibe.whl');

    assert.match(component, /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/);
    assert.equal(
        generateImageTag('vibe', 'mistral-vibe @ https://packages.example.test/builds/vibe.whl', 'abc123'),
        `propr/agent-vibe:${component}-abc123`
    );
});
