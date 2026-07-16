import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
    generateAgentBundleImageTag,
    getAgentBundleVersionHash,
    getAgentCliVersionMatrix,
    getDefaultAgentCliVersionMatrix,
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

test('Antigravity installer versions only allow latest', async () => {
    globalThis.fetch = async () => {
        throw new Error('fetch should not be called for installer-backed CLI versions');
    };

    assert.equal(await resolveVersion('antigravity', 'default'), 'latest');
    assert.equal(await resolveVersion('antigravity', 'tag', 'latest'), 'latest');
    await assert.rejects(
        () => resolveVersion('antigravity', 'tag', 'preview'),
        /Unknown tag 'preview'/
    );
    await assert.rejects(
        () => resolveVersion('antigravity', 'specific', '1.2.3'),
        /only supports the latest version/
    );
});

test('Docker image tags are safe for custom Python install specs', () => {
    const installSpec = 'mistral-vibe @ https://packages.example.test/builds/vibe.whl';
    const component = getDockerTagComponent(installSpec);
    const versions = getDefaultAgentCliVersionMatrix();
    versions.vibe = installSpec;

    assert.match(component, /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/);
    assert.match(
        generateAgentBundleImageTag(versions, 'abc123'),
        /^propr\/agent:bundle-[0-9a-f]{12}-abc123$/
    );
});

test('unified image matrix combines versions across agent types deterministically', () => {
    const matrix = getAgentCliVersionMatrix([
        { type: 'claude', cliVersionResolved: '2.1.200' },
        { type: 'codex', cliVersionResolved: '0.140.0' }
    ]);
    const reordered = getAgentCliVersionMatrix([
        { type: 'codex', cliVersionResolved: '0.140.0' },
        { type: 'claude', cliVersionResolved: '2.1.200' }
    ]);

    assert.equal(matrix.claude, '2.1.200');
    assert.equal(matrix.codex, '0.140.0');
    assert.equal(getAgentBundleVersionHash(matrix), getAgentBundleVersionHash(reordered));
    assert.notEqual(
        getAgentBundleVersionHash(matrix),
        getAgentBundleVersionHash(getDefaultAgentCliVersionMatrix())
    );
});

test('unified image matrix rejects conflicting versions for aliases of one agent type', () => {
    assert.throws(() => getAgentCliVersionMatrix([
        { type: 'codex', cliVersionResolved: '0.140.0' },
        { type: 'codex', cliVersionResolved: '0.141.0' }
    ]), /All codex agents must use the same CLI version/);
});

test('unified image matrix ignores disabled aliases', () => {
    const matrix = getAgentCliVersionMatrix([
        { type: 'codex', enabled: true, cliVersionResolved: '0.140.0' },
        { type: 'codex', enabled: false, cliVersionResolved: '0.141.0' }
    ]);

    assert.equal(matrix.codex, '0.140.0');
});
