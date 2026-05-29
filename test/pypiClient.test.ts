import { afterEach, describe, mock, test } from 'node:test';
import assert from 'node:assert';
import {
    getLatestPyPiVersion,
    getRecentPyPiVersions,
    resolvePyPiVersionSpec
} from '../packages/core/src/agents/version/pypiClient.js';

afterEach(() => {
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
});
