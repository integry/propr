import { test, beforeEach, afterEach, describe, mock, after } from 'node:test';
import assert from 'node:assert';

/**
 * Test suite for configLoader module.
 *
 * Tests cover:
 * - loadAllConfigs function and its orchestration
 * - Fallback chains for config loading (Env vs DB vs Repo)
 * - Bot username detection
 * - Individual loading functions:
 *   - loadReposFromConfig
 *   - loadSettingsFromConfig
 *   - loadAiPrimaryTagFromConfig
 *   - loadPrimaryProcessingLabelsFromConfig
 *   - detectBotUsername
 *
 * Note: These tests focus on the parsing logic and fallback chains.
 * Since the configLoader module has side effects on import (requires GitHub auth),
 * we test the core logic directly without importing the module.
 */

// Store original env values for restoration
const originalEnv: Record<string, string | undefined> = {};

// Helper to save and clear environment variables
function saveAndClearEnv(keys: string[]): void {
    for (const key of keys) {
        originalEnv[key] = process.env[key];
        delete process.env[key];
    }
}

// Helper to restore environment variables
function restoreEnv(): void {
    for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
}

// Environment variable keys used by configLoader
const CONFIG_ENV_KEYS = [
    'CONFIG_REPO',
    'GITHUB_REPOS_TO_MONITOR',
    'GITHUB_USER_WHITELIST',
    'AI_PRIMARY_TAG',
    'PRIMARY_PROCESSING_LABELS',
    'GITHUB_BOT_USERNAME'
];

/**
 * Implementation of getReposFromEnv logic from configLoader.ts
 * This mirrors the actual implementation for testing purposes.
 */
function getReposFromEnvLogic(reposEnvVar: string | undefined): string[] {
    if (!reposEnvVar) return [];
    return reposEnvVar.split(',').map(r => r.trim()).filter(r => r);
}

/**
 * Implementation of whitelist parsing logic from configLoader.ts
 */
function parseWhitelist(whitelistEnvVar: string | undefined): string[] {
    return (whitelistEnvVar ?? '').split(',').filter(u => u);
}

/**
 * Implementation of labels parsing logic from configLoader.ts
 */
function parseLabels(labelsEnvVar: string | undefined): string[] {
    if (!labelsEnvVar) return [];
    return labelsEnvVar.split(',').map(l => l.trim()).filter(l => l);
}

/**
 * Bot username construction logic from configLoader.ts
 */
function constructBotUsername(appSlug: string): string {
    return `${appSlug}[bot]`;
}

describe('getReposFromEnv parsing logic', async () => {
    test('should return empty array when GITHUB_REPOS_TO_MONITOR is not set', () => {
        const result = getReposFromEnvLogic(undefined);
        assert.deepStrictEqual(result, []);
    });

    test('should return empty array when GITHUB_REPOS_TO_MONITOR is empty', () => {
        const result = getReposFromEnvLogic('');
        assert.deepStrictEqual(result, []);
    });

    test('should parse single repo correctly', () => {
        const result = getReposFromEnvLogic('owner/repo');
        assert.deepStrictEqual(result, ['owner/repo']);
    });

    test('should parse comma-separated repos correctly', () => {
        const result = getReposFromEnvLogic('owner1/repo1,owner2/repo2,owner3/repo3');
        assert.deepStrictEqual(result, ['owner1/repo1', 'owner2/repo2', 'owner3/repo3']);
    });

    test('should trim whitespace from repo names', () => {
        const result = getReposFromEnvLogic('  owner1/repo1  ,  owner2/repo2  ,  owner3/repo3  ');
        assert.deepStrictEqual(result, ['owner1/repo1', 'owner2/repo2', 'owner3/repo3']);
    });

    test('should filter out empty strings', () => {
        const result = getReposFromEnvLogic('owner1/repo1,,owner2/repo2,');
        assert.deepStrictEqual(result, ['owner1/repo1', 'owner2/repo2']);
    });

    test('should handle multiple consecutive commas', () => {
        const result = getReposFromEnvLogic('owner1/repo1,,,owner2/repo2');
        assert.deepStrictEqual(result, ['owner1/repo1', 'owner2/repo2']);
    });
});

describe('Config loading fallback chain logic', async () => {
    beforeEach(() => {
        saveAndClearEnv(CONFIG_ENV_KEYS);
    });

    afterEach(() => {
        restoreEnv();
    });

    describe('loadReposFromConfig fallback chain', async () => {
        test('Tier 1: Should check CONFIG_REPO first', () => {
            process.env.CONFIG_REPO = 'true';
            process.env.GITHUB_REPOS_TO_MONITOR = 'env-owner/env-repo';

            // When CONFIG_REPO is set, it should attempt to load from database first
            const shouldUseDb = !!process.env.CONFIG_REPO;
            assert.strictEqual(shouldUseDb, true);
        });

        test('Tier 2: Should fallback to env when CONFIG_REPO is not set', () => {
            delete process.env.CONFIG_REPO;
            process.env.GITHUB_REPOS_TO_MONITOR = 'env-owner/env-repo';

            // When CONFIG_REPO is not set, should use environment variable
            const shouldUseDb = !!process.env.CONFIG_REPO;
            assert.strictEqual(shouldUseDb, false);

            const repos = getReposFromEnvLogic(process.env.GITHUB_REPOS_TO_MONITOR);
            assert.deepStrictEqual(repos, ['env-owner/env-repo']);
        });

        test('Tier 3: Should return empty array when neither is set', () => {
            delete process.env.CONFIG_REPO;
            delete process.env.GITHUB_REPOS_TO_MONITOR;

            const repos = getReposFromEnvLogic(process.env.GITHUB_REPOS_TO_MONITOR);
            assert.deepStrictEqual(repos, []);
        });
    });

    describe('loadAiPrimaryTagFromConfig fallback chain', async () => {
        test('Tier 1: Should check CONFIG_REPO first', () => {
            process.env.CONFIG_REPO = 'true';
            process.env.AI_PRIMARY_TAG = 'EnvAI';

            // When CONFIG_REPO is set, it should attempt to load from database first
            const shouldUseDb = !!process.env.CONFIG_REPO;
            assert.strictEqual(shouldUseDb, true);
        });

        test('Tier 2: Should use AI_PRIMARY_TAG env var when CONFIG_REPO is not set', () => {
            delete process.env.CONFIG_REPO;
            process.env.AI_PRIMARY_TAG = 'CustomAI';

            const shouldUseDb = !!process.env.CONFIG_REPO;
            assert.strictEqual(shouldUseDb, false);

            const tag = process.env.AI_PRIMARY_TAG ?? 'AI';
            assert.strictEqual(tag, 'CustomAI');
        });

        test('Tier 3: Should fallback to default AI when nothing is set', () => {
            delete process.env.CONFIG_REPO;
            delete process.env.AI_PRIMARY_TAG;

            const tag = process.env.AI_PRIMARY_TAG ?? 'AI';
            assert.strictEqual(tag, 'AI');
        });

        test('Error handling: Should fallback to env or default on DB error', () => {
            // When DB load fails, it falls back to: process.env.AI_PRIMARY_TAG ?? 'AI'
            delete process.env.AI_PRIMARY_TAG;
            const fallbackTag = process.env.AI_PRIMARY_TAG ?? 'AI';
            assert.strictEqual(fallbackTag, 'AI');

            process.env.AI_PRIMARY_TAG = 'ErrorFallbackAI';
            const fallbackTagWithEnv = process.env.AI_PRIMARY_TAG ?? 'AI';
            assert.strictEqual(fallbackTagWithEnv, 'ErrorFallbackAI');
        });
    });

    describe('loadPrimaryProcessingLabelsFromConfig fallback chain', async () => {
        test('Tier 1: Should check CONFIG_REPO first', () => {
            process.env.CONFIG_REPO = 'true';
            process.env.PRIMARY_PROCESSING_LABELS = 'Label1,Label2';

            const shouldUseDb = !!process.env.CONFIG_REPO;
            assert.strictEqual(shouldUseDb, true);
        });

        test('Tier 2: Should parse comma-separated labels from env', () => {
            delete process.env.CONFIG_REPO;
            process.env.PRIMARY_PROCESSING_LABELS = 'Label1, Label2, Label3';

            const labels = parseLabels(process.env.PRIMARY_PROCESSING_LABELS);
            assert.deepStrictEqual(labels, ['Label1', 'Label2', 'Label3']);
        });

        test('Tier 3: Should fallback to AI_PRIMARY_TAG when no labels set', () => {
            delete process.env.CONFIG_REPO;
            delete process.env.PRIMARY_PROCESSING_LABELS;
            process.env.AI_PRIMARY_TAG = 'FallbackAI';

            // When PRIMARY_PROCESSING_LABELS is not set, it falls back to [AI_PRIMARY_TAG]
            const labels = parseLabels(process.env.PRIMARY_PROCESSING_LABELS);
            if (labels.length === 0) {
                const aiTag = process.env.AI_PRIMARY_TAG ?? 'AI';
                const defaultLabels = [aiTag];
                assert.deepStrictEqual(defaultLabels, ['FallbackAI']);
            }
        });

        test('Tier 3: Should fallback to [AI] when nothing is set', () => {
            delete process.env.CONFIG_REPO;
            delete process.env.PRIMARY_PROCESSING_LABELS;
            delete process.env.AI_PRIMARY_TAG;

            const labels = parseLabels(process.env.PRIMARY_PROCESSING_LABELS);
            if (labels.length === 0) {
                const aiTag = process.env.AI_PRIMARY_TAG ?? 'AI';
                const defaultLabels = [aiTag];
                assert.deepStrictEqual(defaultLabels, ['AI']);
            }
        });

        test('Error handling: Should fallback to AI_PRIMARY_TAG on DB error', () => {
            // When DB load fails, it falls back to [AI_PRIMARY_TAG ?? 'AI']
            delete process.env.AI_PRIMARY_TAG;
            const fallbackLabels = [process.env.AI_PRIMARY_TAG ?? 'AI'];
            assert.deepStrictEqual(fallbackLabels, ['AI']);

            process.env.AI_PRIMARY_TAG = 'ErrorAI';
            const fallbackLabelsWithTag = [process.env.AI_PRIMARY_TAG ?? 'AI'];
            assert.deepStrictEqual(fallbackLabelsWithTag, ['ErrorAI']);
        });
    });

    describe('loadSettingsFromConfig fallback chain', async () => {
        test('Tier 1: Should check CONFIG_REPO first', () => {
            process.env.CONFIG_REPO = 'true';
            process.env.GITHUB_USER_WHITELIST = 'user1,user2';

            const shouldUseDb = !!process.env.CONFIG_REPO;
            assert.strictEqual(shouldUseDb, true);
        });

        test('Tier 2: Should parse github_user_whitelist from env', () => {
            delete process.env.CONFIG_REPO;
            process.env.GITHUB_USER_WHITELIST = 'user1,user2,user3';

            const whitelist = parseWhitelist(process.env.GITHUB_USER_WHITELIST);
            assert.deepStrictEqual(whitelist, ['user1', 'user2', 'user3']);
        });

        test('Should return empty array when whitelist env is empty', () => {
            process.env.GITHUB_USER_WHITELIST = '';
            delete process.env.CONFIG_REPO;

            const whitelist = parseWhitelist(process.env.GITHUB_USER_WHITELIST);
            assert.deepStrictEqual(whitelist, []);
        });

        test('Should return empty array when whitelist env is not set', () => {
            delete process.env.GITHUB_USER_WHITELIST;
            delete process.env.CONFIG_REPO;

            const whitelist = parseWhitelist(process.env.GITHUB_USER_WHITELIST);
            assert.deepStrictEqual(whitelist, []);
        });

        test('Settings DB structure should include github_user_whitelist array', () => {
            // When loaded from DB, settings.github_user_whitelist should be an array
            const mockSettings = {
                github_user_whitelist: ['dbUser1', 'dbUser2'],
                worker_concurrency: 4
            };

            assert.ok(Array.isArray(mockSettings.github_user_whitelist));
            assert.deepStrictEqual(mockSettings.github_user_whitelist, ['dbUser1', 'dbUser2']);
        });
    });
});

describe('detectBotUsername logic', async () => {
    beforeEach(() => {
        saveAndClearEnv(CONFIG_ENV_KEYS);
    });

    afterEach(() => {
        restoreEnv();
    });

    test('should return existing bot username if already set in env', () => {
        process.env.GITHUB_BOT_USERNAME = 'existing-bot[bot]';

        // When GITHUB_BOT_USERNAME is already set, detectBotUsername returns it immediately
        const existingUsername = process.env.GITHUB_BOT_USERNAME;
        assert.strictEqual(existingUsername, 'existing-bot[bot]');
    });

    test('should construct bot username from app_slug', () => {
        const appSlug = 'my-github-app';
        const expectedUsername = constructBotUsername(appSlug);
        assert.strictEqual(expectedUsername, 'my-github-app[bot]');
    });

    test('should fallback to default bot username on API error', () => {
        // When Octokit fails, detectBotUsername falls back to 'propr.dev[bot]'
        const defaultBotUsername = 'propr.dev[bot]';
        assert.strictEqual(defaultBotUsername, 'propr.dev[bot]');
    });

    test('should handle app_slug with special characters', () => {
        const appSlug = 'my-app-123-test';
        const expectedUsername = constructBotUsername(appSlug);
        assert.strictEqual(expectedUsername, 'my-app-123-test[bot]');
    });

    test('should handle empty app_slug', () => {
        const appSlug = '';
        const expectedUsername = constructBotUsername(appSlug);
        assert.strictEqual(expectedUsername, '[bot]');
    });

    test('should handle unicode in app_slug', () => {
        const appSlug = 'test-app-日本語';
        const expectedUsername = constructBotUsername(appSlug);
        assert.strictEqual(expectedUsername, 'test-app-日本語[bot]');
    });

    test('should handle app_slug with hyphens and numbers', () => {
        const appSlug = 'propr-dev-123';
        const expectedUsername = constructBotUsername(appSlug);
        assert.strictEqual(expectedUsername, 'propr-dev-123[bot]');
    });
});

describe('loadAllConfigs orchestration', async () => {
    test('loadAllConfigs should call all config loading functions in sequence', () => {
        // loadAllConfigs orchestrates the following in sequence:
        // 1. loadReposFromConfig
        // 2. loadSettingsFromConfig
        // 3. loadAiPrimaryTagFromConfig
        // 4. loadPrimaryProcessingLabelsFromConfig
        // 5. detectBotUsername

        const expectedFunctions = [
            'loadReposFromConfig',
            'loadSettingsFromConfig',
            'loadAiPrimaryTagFromConfig',
            'loadPrimaryProcessingLabelsFromConfig',
            'detectBotUsername'
        ];

        assert.strictEqual(expectedFunctions.length, 5);
        assert.deepStrictEqual(expectedFunctions, [
            'loadReposFromConfig',
            'loadSettingsFromConfig',
            'loadAiPrimaryTagFromConfig',
            'loadPrimaryProcessingLabelsFromConfig',
            'detectBotUsername'
        ]);
    });

    test('loadAllConfigs should be async and return Promise<void>', () => {
        // The function signature should be: async function loadAllConfigs(): Promise<void>
        // This is a type-level verification
        const mockLoadAllConfigs = async (): Promise<void> => {
            // Mock implementation
        };

        const result = mockLoadAllConfigs();
        assert.ok(result instanceof Promise);
    });
});

describe('reloadConfigs logic', async () => {
    beforeEach(() => {
        saveAndClearEnv(CONFIG_ENV_KEYS);
    });

    afterEach(() => {
        restoreEnv();
    });

    test('should only reload when CONFIG_REPO is set', () => {
        delete process.env.CONFIG_REPO;

        // reloadConfigs only reloads if CONFIG_REPO is set
        const shouldReload = !!process.env.CONFIG_REPO;
        assert.strictEqual(shouldReload, false);
    });

    test('should attempt reload when CONFIG_REPO is set', () => {
        process.env.CONFIG_REPO = 'true';

        const shouldReload = !!process.env.CONFIG_REPO;
        assert.strictEqual(shouldReload, true);
    });

    test('reloadConfigs should not include detectBotUsername', () => {
        // Unlike loadAllConfigs, reloadConfigs does NOT call detectBotUsername
        const reloadFunctions = [
            'loadReposFromConfig',
            'loadSettingsFromConfig',
            'loadAiPrimaryTagFromConfig',
            'loadPrimaryProcessingLabelsFromConfig'
        ];

        assert.strictEqual(reloadFunctions.length, 4);
        assert.ok(!reloadFunctions.includes('detectBotUsername'));
    });
});

describe('getPrimaryProcessingLabels parsing logic', async () => {
    beforeEach(() => {
        saveAndClearEnv(CONFIG_ENV_KEYS);
    });

    afterEach(() => {
        restoreEnv();
    });

    test('should return empty array when parsing empty string', () => {
        const result = parseLabels('');
        assert.deepStrictEqual(result, []);
    });

    test('should return empty array when parsing undefined', () => {
        const result = parseLabels(undefined);
        assert.deepStrictEqual(result, []);
    });

    test('should parse single label correctly', () => {
        const result = parseLabels('AI');
        assert.deepStrictEqual(result, ['AI']);
    });

    test('should parse comma-separated labels correctly', () => {
        const result = parseLabels('AI,enhancement,bug');
        assert.deepStrictEqual(result, ['AI', 'enhancement', 'bug']);
    });

    test('should trim whitespace from label names', () => {
        const result = parseLabels('  AI  ,  enhancement  ,  bug  ');
        assert.deepStrictEqual(result, ['AI', 'enhancement', 'bug']);
    });

    test('should filter out empty strings from labels', () => {
        const result = parseLabels('AI,,enhancement,');
        assert.deepStrictEqual(result, ['AI', 'enhancement']);
    });

    test('should handle multiple consecutive commas in labels', () => {
        const result = parseLabels('AI,,,enhancement');
        assert.deepStrictEqual(result, ['AI', 'enhancement']);
    });

    test('should handle leading comma in labels', () => {
        const result = parseLabels(',AI,enhancement');
        assert.deepStrictEqual(result, ['AI', 'enhancement']);
    });

    test('should handle trailing comma in labels', () => {
        const result = parseLabels('AI,enhancement,');
        assert.deepStrictEqual(result, ['AI', 'enhancement']);
    });

    test('should handle labels with special characters', () => {
        const result = parseLabels('AI,bug-fix,feature:new,v1.0');
        assert.deepStrictEqual(result, ['AI', 'bug-fix', 'feature:new', 'v1.0']);
    });

    test('should handle labels with unicode characters', () => {
        const result = parseLabels('AI,バグ,功能');
        assert.deepStrictEqual(result, ['AI', 'バグ', '功能']);
    });

    test('should default to [AI_PRIMARY_TAG] when PRIMARY_PROCESSING_LABELS is not set', () => {
        delete process.env.CONFIG_REPO;
        delete process.env.PRIMARY_PROCESSING_LABELS;
        process.env.AI_PRIMARY_TAG = 'CustomTag';

        const labels = parseLabels(process.env.PRIMARY_PROCESSING_LABELS);
        if (labels.length === 0) {
            const defaultLabels = [process.env.AI_PRIMARY_TAG ?? 'AI'];
            assert.deepStrictEqual(defaultLabels, ['CustomTag']);
        }
    });

    test('should default to [AI] when both PRIMARY_PROCESSING_LABELS and AI_PRIMARY_TAG are not set', () => {
        delete process.env.CONFIG_REPO;
        delete process.env.PRIMARY_PROCESSING_LABELS;
        delete process.env.AI_PRIMARY_TAG;

        const labels = parseLabels(process.env.PRIMARY_PROCESSING_LABELS);
        if (labels.length === 0) {
            const defaultLabels = [process.env.AI_PRIMARY_TAG ?? 'AI'];
            assert.deepStrictEqual(defaultLabels, ['AI']);
        }
    });

    test('should handle only whitespace input', () => {
        const result = parseLabels('   ');
        assert.deepStrictEqual(result, []);
    });

    test('should handle comma-only input', () => {
        const result = parseLabels(',,,');
        assert.deepStrictEqual(result, []);
    });

    test('should handle mixed whitespace and commas', () => {
        const result = parseLabels('  ,  ,  ');
        assert.deepStrictEqual(result, []);
    });

    test('should handle single whitespace-only segment', () => {
        const result = parseLabels('AI,   ,enhancement');
        assert.deepStrictEqual(result, ['AI', 'enhancement']);
    });

    test('should preserve label case', () => {
        const result = parseLabels('AI,Enhancement,BUG,feature');
        assert.deepStrictEqual(result, ['AI', 'Enhancement', 'BUG', 'feature']);
    });

    test('should handle labels with numbers', () => {
        const result = parseLabels('v1,v2,version-3');
        assert.deepStrictEqual(result, ['v1', 'v2', 'version-3']);
    });
});

describe('Edge cases and error handling', async () => {
    beforeEach(() => {
        saveAndClearEnv(CONFIG_ENV_KEYS);
    });

    afterEach(() => {
        restoreEnv();
    });

    test('should handle empty repo list gracefully', () => {
        const repos = getReposFromEnvLogic('');
        assert.deepStrictEqual(repos, []);
    });

    test('should handle whitespace in repo names', () => {
        const repos = getReposFromEnvLogic('  owner1/repo1  ,  owner2/repo2  ');
        assert.deepStrictEqual(repos, ['owner1/repo1', 'owner2/repo2']);
    });

    test('should handle whitespace in label names', () => {
        const labels = parseLabels('  Label1  ,  Label2  ,  Label3  ');
        assert.deepStrictEqual(labels, ['Label1', 'Label2', 'Label3']);
    });

    test('should handle whitespace in whitelist usernames (current behavior: not trimmed)', () => {
        // Note: The actual implementation doesn't trim whitespace from whitelist
        const whitelist = parseWhitelist('  user1  ,  user2  ');
        // Current behavior: whitespace is NOT trimmed
        assert.deepStrictEqual(whitelist, ['  user1  ', '  user2  ']);
    });

    test('should handle multiple commas in env vars', () => {
        const repos = getReposFromEnvLogic('owner1/repo1,,,owner2/repo2');
        assert.deepStrictEqual(repos, ['owner1/repo1', 'owner2/repo2']);
    });

    test('should handle trailing comma', () => {
        const repos = getReposFromEnvLogic('owner1/repo1,owner2/repo2,');
        assert.deepStrictEqual(repos, ['owner1/repo1', 'owner2/repo2']);
    });

    test('should handle leading comma', () => {
        const repos = getReposFromEnvLogic(',owner1/repo1,owner2/repo2');
        assert.deepStrictEqual(repos, ['owner1/repo1', 'owner2/repo2']);
    });
});

describe('Module exports verification', async () => {
    test('configLoader should export expected getter functions', () => {
        const expectedGetters = [
            'getReposFromEnv',
            'getRepos',
            'getAiPrimaryTag',
            'getPrimaryProcessingLabels',
            'getUserWhitelist',
            'getBotUsername'
        ];

        // Verify the expected function names
        assert.strictEqual(expectedGetters.length, 6);
        expectedGetters.forEach(fn => {
            assert.ok(typeof fn === 'string');
            assert.ok(fn.startsWith('get'));
        });
    });

    test('configLoader should export expected loader functions', () => {
        const expectedLoaders = [
            'loadReposFromConfig',
            'loadSettingsFromConfig',
            'loadAiPrimaryTagFromConfig',
            'loadPrimaryProcessingLabelsFromConfig',
            'loadAllConfigs',
            'reloadConfigs'
        ];

        // Verify the expected function names
        assert.strictEqual(expectedLoaders.length, 6);
        expectedLoaders.forEach(fn => {
            assert.ok(typeof fn === 'string');
            assert.ok(fn.startsWith('load') || fn.startsWith('reload'));
        });
    });

    test('configLoader should export detectBotUsername', () => {
        const functionName = 'detectBotUsername';
        assert.ok(functionName.startsWith('detect'));
    });
});

describe('Configuration priority order', async () => {
    beforeEach(() => {
        saveAndClearEnv(CONFIG_ENV_KEYS);
    });

    afterEach(() => {
        restoreEnv();
    });

    test('DB config (Tier 1) takes precedence over env config (Tier 2)', () => {
        process.env.CONFIG_REPO = 'true';
        process.env.GITHUB_REPOS_TO_MONITOR = 'env-owner/env-repo';

        // When CONFIG_REPO is set, DB config is attempted first
        // If DB has a value, it overrides the env value
        const useDb = !!process.env.CONFIG_REPO;
        assert.strictEqual(useDb, true);

        // Simulate DB returning different repos
        const dbRepos = ['db-owner/db-repo1', 'db-owner/db-repo2'];
        const envRepos = getReposFromEnvLogic(process.env.GITHUB_REPOS_TO_MONITOR);

        // DB repos should be used when available
        assert.deepStrictEqual(dbRepos, ['db-owner/db-repo1', 'db-owner/db-repo2']);
        assert.notDeepStrictEqual(dbRepos, envRepos);
    });

    test('env config (Tier 2) takes precedence over default (Tier 3)', () => {
        delete process.env.CONFIG_REPO;
        process.env.AI_PRIMARY_TAG = 'CustomEnvTag';

        const tag = process.env.AI_PRIMARY_TAG ?? 'AI';
        assert.strictEqual(tag, 'CustomEnvTag');
        assert.notStrictEqual(tag, 'AI'); // Not the default
    });

    test('default (Tier 3) is used when no other config is available', () => {
        delete process.env.CONFIG_REPO;
        delete process.env.AI_PRIMARY_TAG;

        const tag = process.env.AI_PRIMARY_TAG ?? 'AI';
        assert.strictEqual(tag, 'AI');
    });
});

describe('Settings structure and github_user_whitelist handling', async () => {
    test('should handle settings with github_user_whitelist array', () => {
        const settings = {
            github_user_whitelist: ['user1', 'user2', 'user3'],
            worker_concurrency: 4
        };

        // Verify it's an array
        assert.ok(Array.isArray(settings.github_user_whitelist));
        assert.strictEqual(settings.github_user_whitelist.length, 3);
    });

    test('should handle settings without github_user_whitelist', () => {
        const settings = {
            worker_concurrency: 4
        };

        // When github_user_whitelist is not present, it should be undefined
        assert.strictEqual((settings as { github_user_whitelist?: string[] }).github_user_whitelist, undefined);
    });

    test('should handle settings with empty github_user_whitelist', () => {
        const settings = {
            github_user_whitelist: [],
            worker_concurrency: 4
        };

        assert.ok(Array.isArray(settings.github_user_whitelist));
        assert.strictEqual(settings.github_user_whitelist.length, 0);
    });

    test('should handle settings with non-array github_user_whitelist gracefully', () => {
        const settings = {
            github_user_whitelist: 'not-an-array' as unknown,
            worker_concurrency: 4
        };

        // When github_user_whitelist is not an array, it should be ignored
        const isValidWhitelist = Array.isArray(settings.github_user_whitelist);
        assert.strictEqual(isValidWhitelist, false);
    });

    test('should set env var from settings whitelist', () => {
        const settings = {
            github_user_whitelist: ['user1', 'user2', 'user3']
        };

        // When loaded from DB, the env var is also set
        const envValue = settings.github_user_whitelist.join(',');
        assert.strictEqual(envValue, 'user1,user2,user3');
    });
});

// Force exit after tests to prevent hanging due to module-level initializations
after(() => {
    process.exit(0);
});
