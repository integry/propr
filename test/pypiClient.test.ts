import { afterEach, describe, mock, test } from 'node:test';
import assert from 'node:assert';
import {
    clearPyPiPackageInfoCache,
    getLatestPyPiVersion,
    getRecentPyPiVersions,
    resolvePyPiVersionSpec
} from '../packages/core/src/agents/version/pypiClient.js';
import {
    generateImageTag,
    getAvailableVersions,
    resolveVersion
} from '../packages/core/src/agents/version/versionService.js';

afterEach(() => {
    clearPyPiPackageInfoCache();
    mock.restoreAll();
});

function mockPyPiResponse(body: unknown, init?: ResponseInit): void {
    mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(body), init));
}

describe('pypiClient', () => {
    test('resolves latest from package info', async () => {
        mockPyPiResponse({
            info: { version: '2.12.1' },
            releases: {}
        });

        assert.strictEqual(await getLatestPyPiVersion('mistral-vibe-latest-test'), '2.12.1');
    });

    test('returns recent versions from non-yanked files only', async () => {
        mockPyPiResponse({
            info: { version: '2.12.1' },
            releases: {
                '2.12.1': [{ upload_time_iso_8601: '2026-01-03T00:00:00Z' }],
                '2.12.0': [{ upload_time_iso_8601: '2026-01-02T00:00:00Z', yanked: true }],
                '2.11.0': [{ upload_time_iso_8601: '2026-01-01T00:00:00Z' }]
            }
        });

        assert.deepStrictEqual(await getRecentPyPiVersions('mistral-vibe-recent-test', 10), [
            { version: '2.12.1', publishedAt: '2026-01-03T00:00:00Z' },
            { version: '2.11.0', publishedAt: '2026-01-01T00:00:00Z' }
        ]);
    });

    test('rejects missing and fully yanked specific versions', async () => {
        mockPyPiResponse({
            info: { version: '2.12.1' },
            releases: {
                '2.12.0': [{ upload_time_iso_8601: '2026-01-02T00:00:00Z', yanked: true }]
            }
        });

        await assert.rejects(
            () => resolvePyPiVersionSpec('mistral-vibe-yanked-test', '2.12.0'),
            /Version '2\.12\.0' not found/
        );
    });

    test('maps aborted fetches to timeout errors', async () => {
        mock.method(globalThis, 'fetch', async () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            throw error;
        });

        await assert.rejects(
            () => getLatestPyPiVersion('mistral-vibe-timeout-test'),
            /PyPI request timed out/
        );
    });

    test('resolves Vibe latest tag through the version service', async () => {
        mockPyPiResponse({
            info: { version: '2.12.1' },
            releases: {
                '2.12.1': [{ upload_time_iso_8601: '2026-01-03T00:00:00Z' }],
                '2.11.0': [{ upload_time_iso_8601: '2026-01-01T00:00:00Z' }]
            }
        });

        assert.strictEqual(await resolveVersion('vibe', 'tag', 'latest'), '2.12.1');
    });

    test('rejects unsupported PyPI tags through the version service', async () => {
        await assert.rejects(
            () => resolveVersion('vibe', 'tag', 'beta'),
            /Unknown tag 'beta'/
        );
    });

    test('rejects empty custom Vibe versions after trimming', async () => {
        await assert.rejects(
            () => resolveVersion('vibe', 'custom', '   '),
            /Version spec required/
        );
    });

    test('generates Vibe versioned tags in the local image namespace', () => {
        assert.strictEqual(generateImageTag('vibe', '2.12.1', 'abcdef'), 'propr-vibe:2.12.1-abcdef');
    });

    test('returns Vibe available versions in API-facing shape', async () => {
        mockPyPiResponse({
            info: { version: '2.12.1' },
            releases: {
                '2.12.1': [{ upload_time_iso_8601: '2026-01-03T00:00:00Z' }],
                '2.11.0': [{ upload_time_iso_8601: '2026-01-01T00:00:00Z' }]
            }
        });

        const versions = await getAvailableVersions('vibe');
        assert.strictEqual(versions.agentType, 'vibe');
        assert.strictEqual(versions.packageName, 'mistral-vibe');
        assert.deepStrictEqual(versions.availableTags, [{ tag: 'latest', version: '2.12.1' }]);
        assert.deepStrictEqual(versions.recentVersions, [
            { version: '2.12.1', publishedAt: '2026-01-03T00:00:00Z' },
            { version: '2.11.0', publishedAt: '2026-01-01T00:00:00Z' }
        ]);
    });
});
